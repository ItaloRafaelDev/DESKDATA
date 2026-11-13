import { basename } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page, type Frame, type Request } from 'playwright-core';
import { filterPendingPerson29, readListingCount, type CpiPendingFilterResult } from './pending-filter.ts';
import { inspectPendingPerson29Rows, validateCpiRowId, type CpiPendingRowId, type CpiPendingRowsInspection } from './pending-rows.ts';
import { validateCpiPersonDetails, resolveCpiDetailHeadings, matchesCpiDetailHeadings, readCpiDetailDom, type CpiDetailDomSnapshot, type CpiRawPersonDetails, type CpiPendingPersonDetail } from './pending-details.ts';
import { classifyCpiVisibleServerError, hasConfirmedSavedCpiResponse, type CpiSavedResponseEvidence } from './response-confirmation.ts';
import { refreshPendingAfterConfirmedSave } from './pending-refresh.ts';
import { cpfDigits, isValidCpf } from '../../shared/cpf.ts';
import { NULL_TIMER, type EndStep, type StepTimer } from '../step-timing.ts';
import { isDeadlineError, runWithDeadline, throwIfAborted, withDeadline } from '../deadline.ts';

export const CPI_LOGIN_URL = 'https://adm.cpicentral.com.br/acesso/checkUser.aspx';
const CPI_HOST = 'adm.cpicentral.com.br';

/**
 * Prazo total por operação do navegador (E3). Cada valor cobre a soma dos limites internos já existentes
 * na operação (goto, cliques, laços de polling) mais folga; passos sem limite próprio (`frame.evaluate`,
 * `contentFrame`, `newContext`, `bringToFront`, `browser.close`) ficam cobertos por este prazo.
 * O salvamento recebe ainda o tempo de confirmação do envio.
 */
export const CPI_OPERATION_TIMEOUTS = {
  open: 75_000, focus: 5_000, close: 15_000, inspect: 20_000, filter: 150_000, rows: 30_000,
  detail: 45_000, save: 60_000, closeDetail: 75_000, reconcile: 45_000
};
export type CpiOperationTimeouts = typeof CPI_OPERATION_TIMEOUTS;
/** Estado do salvamento visível ao chamador, que decide no estouro do prazo sem esperar o corpo. */
/** `effectsPossible`: o clique em "Alterar" pode ter ocorrido (só a partir do checkpoint `submit_started`). */
interface SaveProgress { effectsPossible: boolean; endStep: EndStep | null }
/**
 * `confirmed`: confirmação aceita e modal fechado (a listagem é conferida em `closeCompletedDetail`).
 * `confirm_mismatch`: texto da confirmação divergente; cancelada, nada enviado (revisão manual).
 */
export type CpiSaveResult = 'confirmed' | 'confirmed_auxiliary_404' | 'unverified' | 'not_submitted' | 'confirm_mismatch';
/** Rótulos dos radios `consta` do portal ("Nada Consta" nunca é automático). */
export const CPI_RESULT_LABELS = { information: 'Há Informações', restrictions: 'Sim, Consta Restrições' } as const;
export type CpiDiagnosticsSink = (event: string, fields: Record<string, unknown>) => void;
/** Motivos fixos da falha antes do clique (vão ao diagnóstico como `errorType`; nunca contêm dados da pesquisa). */
type SaveFailure = 'CpiDetailError' | 'CpiIdentityChangedError' | 'CpiFrameReloadError' | 'CpiFormFieldError' | 'CpiResultRadioError' |
  'CpiFileInputError' | 'CpiSaveButtonError' | 'CpiFormActionError' | 'CpiAttachRejectedError' | 'CpiCheckpointError';
function saveFailure(name: SaveFailure, message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { name });
}

export interface CpiBrowserStatus { state: 'closed' | 'open'; host?: string }
export interface CpiControlInfo { tag: string; id?: string; name?: string; type?: string; role?: string }
export interface CpiDomInspection { controls: CpiControlInfo[]; truncated: boolean; framesInspected: number }

function safeAttribute(value: string | null): string | undefined {
  if (!value || value.length > 110 || /\d{9,}/.test(value) || /@/.test(value) || /(?:password|secret|token|cookie|session|viewstate|validation|csrf|auth|credential)/i.test(value)) return undefined;
  // Apenas identificadores HTML; nunca valores digitados, texto das linhas ou dados de pessoas.
  return /^[A-Za-z0-9_:$.-]+$/.test(value) ? value : undefined;
}

/** Fase 1: somente navegação manual e inspeção de metadados DOM, sem escritas no portal. */
export class CpiBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private opening: Promise<CpiBrowserStatus> | null = null;
  private lastFilter: {result: CpiPendingFilterResult; pageUrl: string; checkedAt: number} | null = null;
  private lastMappedRows: CpiPendingRowId[] = [];
  private lastReadCpf: {ids: CpiPendingRowId; cpf: string; frame:Frame} | null = null;
  private lastConfirmedSave: (CpiPendingRowId & {frame:Frame}) | null = null;
  private diagnostics: CpiDiagnosticsSink | null = null;
  /** Diagnóstico sanitizado (só nomes fixos, método e caminho); nunca recebe dados da pesquisa. */
  setDiagnostics(sink: CpiDiagnosticsSink | null): void { this.diagnostics = sink; }
  /** Abortado por `close()`: toda operação em curso para no próximo ponto de verificação. */
  private session = new AbortController();
  private readonly timeouts: CpiOperationTimeouts;
  constructor(timeouts: Partial<CpiOperationTimeouts> = {}) { this.timeouts = {...CPI_OPERATION_TIMEOUTS, ...timeouts}; }

  /** Operação com prazo próprio e cancelável pelo fechamento do navegador. */
  private bounded<T>(label: string, ms: number, body: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return runWithDeadline(label, ms, body, this.session.signal);
  }

  status(): CpiBrowserStatus {
    if (!this.browser?.isConnected() || !this.page || this.page.isClosed()) return { state: 'closed' };
    try {
      const current = new URL(this.page.url());
      return { state: 'open', host: current.hostname === CPI_HOST ? CPI_HOST : 'Página externa ou inicial' };
    } catch { return { state: 'open' }; }
  }
  async open(): Promise<CpiBrowserStatus> {
    if (this.opening) return this.opening;
    if (this.status().state === 'open') {
      const page = this.page;
      if (page) await withDeadline(page.bringToFront(), this.timeouts.focus, 'cpi_focus');
      return this.status();
    }
    // Se a aba foi fechada manualmente, liberar o processo anterior antes de abrir outro.
    if (this.browser) await this.close();
    this.opening = this.bounded('cpi_open', this.timeouts.open, signal => this.launch(signal));
    try { return await this.opening; } finally { this.opening = null; }
  }
  private async launch(signal: AbortSignal): Promise<CpiBrowserStatus> {
    const browser = await chromium.launch({ channel: 'msedge', headless: false, timeout: 25000 });
    try {
      // Prazo estourado durante a abertura: o processo recém-criado é encerrado em vez de ficar órfão.
      throwIfAborted(signal, 'cpi_open');
      const context = await browser.newContext({ acceptDownloads: false });
      throwIfAborted(signal, 'cpi_open');
      const page = await context.newPage();
      throwIfAborted(signal, 'cpi_open');
      this.browser = browser;
      this.context = context;
      this.page = page;
      browser.on('disconnected', () => { if (this.browser === browser) { this.browser = null; this.context = null; this.page = null; this.lastFilter = null; this.lastMappedRows = []; this.lastReadCpf = null; this.lastConfirmedSave = null; } });
      await page.goto(CPI_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      throwIfAborted(signal, 'cpi_open');
      return this.status();
    } catch (error) {
      if (this.browser === browser) { this.browser = null; this.context = null; this.page = null; }
      await this.closeBrowser(browser);
      throw error;
    }
  }
  /**
   * `browser.close()` com prazo. Falha ou estouro não são propagados: as referências já foram descartadas,
   * a sessão (cookies em memória) não é reutilizada e um novo `open()` cria outro processo.
   */
  private async closeBrowser(browser: Browser): Promise<void> {
    await withDeadline(browser.close(), this.timeouts.close, 'cpi_close').catch(() => undefined);
  }
  async inspectControls(): Promise<CpiDomInspection> {
    if (this.status().state !== 'open' || !this.page) throw new Error('Abra primeiro o navegador CPI.');
    const page = this.page;
    return this.bounded('cpi_inspect', this.timeouts.inspect, signal => this.inspectControlsIn(page, signal));
  }
  private async inspectControlsIn(page: Page, signal: AbortSignal): Promise<CpiDomInspection> {
    const controls: CpiControlInfo[] = [];
    let framesInspected = 0;
    let truncated = false;
    for (const frame of page.frames()) {
      throwIfAborted(signal, 'cpi_inspect');
      let host: string;
      try { host = new URL(frame.url()).hostname; } catch { continue; }
      if (host !== CPI_HOST) continue;
      framesInspected++;
      const elements = await frame.locator('input, select, textarea, button').evaluateAll(nodes =>
        nodes.filter(node => {
          const input = node as HTMLInputElement;
          return input.type !== 'hidden' && input.type !== 'password';
        }).map(node => ({
          tag: node.tagName.toLowerCase(), id: node.getAttribute('id'),
          name: node.getAttribute('name'), type: node.getAttribute('type'), role: node.getAttribute('role')
        }))
      );
      for (const item of elements) {
        if (controls.length >= 120) { truncated = true; break; }
        controls.push({ tag: item.tag, id: safeAttribute(item.id), name: safeAttribute(item.name), type: safeAttribute(item.type), role: safeAttribute(item.role) });
      }
      if (truncated) break;
    }
    if (!framesInspected) throw new Error('A página ativa não pertence ao domínio administrativo CPI.');
    return { controls, truncated, framesInspected };
  }
  async filterPendingPerson29(): Promise<CpiPendingFilterResult> {
    if (this.status().state !== 'open' || !this.page) throw new Error('Abra e autentique primeiro o navegador CPI.');
    this.lastFilter = null;
    this.lastMappedRows = [];
    this.lastReadCpf = null;
    this.lastConfirmedSave = null;
    const page = this.page;
    return this.bounded('cpi_filter', this.timeouts.filter, async signal => {
      const result = await filterPendingPerson29(page, signal);
      // Resultado tardio de uma operação já expirada nunca vira estado válido.
      throwIfAborted(signal, 'cpi_filter');
      if (result.total !== null && result.state !== 'unconfirmed') {
        this.lastFilter = {result, pageUrl: page.url(), checkedAt: Date.now()};
      }
      return result;
    });
  }
  /** Lê a tabela que já está na tela; nunca abre o modal de filtros novamente. */
  async inspectPendingRows(): Promise<CpiPendingRowsInspection> {
    if (this.status().state !== 'open' || !this.page) throw new Error('Abra e autentique primeiro o navegador CPI.');
    this.lastMappedRows = [];
    this.lastReadCpf = null;
    this.lastConfirmedSave = null;
    const last = this.lastFilter;
    if (!last || last.result.total === null || this.page.url() !== last.pageUrl ||
        Date.now() - last.checkedAt > 300000) {
      throw new Error('O filtro 29 deve ser executado novamente antes da leitura da listagem.');
    }
    const page = this.page;
    return this.bounded('cpi_rows', this.timeouts.rows, async signal => {
      const currentTotal = await readListingCount(page, 4000, signal);
      if (currentTotal !== last.result.total) {
        return {state:'unconfirmed',total:currentTotal,visibleRows:0,rows:[],framesInspected:0,
          message:'A listagem mudou após a filtragem. Atualize o filtro 29 antes de continuar.'} as CpiPendingRowsInspection;
      }
      const result = await inspectPendingPerson29Rows(page, currentTotal);
      throwIfAborted(signal, 'cpi_rows');
      if (result.state === 'mapped') this.lastMappedRows = result.rows;
      return result;
    });
  }

  /** Abre somente o formulário existente de um registro mapeado; não salva nem consulta a Deskdata. */
  async inspectPendingPersonDetails(ids: CpiPendingRowId, timer: Pick<StepTimer,'begin'> = NULL_TIMER): Promise<CpiPendingPersonDetail> {
    if (this.status().state !== 'open' || !this.page) throw new Error('Abra e autentique primeiro o navegador CPI.');
    if (!validateCpiRowId(ids) || !this.lastMappedRows.some(row =>
      row.pesquisaId === ids.pesquisaId && row.solicitacaoId === ids.solicitacaoId)) {
      throw new Error('A pesquisa não foi identificada e validada na listagem atual.');
    }
    const page = this.page;
    this.lastReadCpf = null;
    let endStep = timer.begin('cpi_open_detail');
    try {
    return await this.bounded('cpi_open_detail', this.timeouts.detail, async signal => {
    // Se o usuário já abriu manualmente o mesmo formulário, aproveitá-lo sem segundo clique.
    let raw = await this.readDetailsFromOpenFrame(ids);
    if (!raw) {
      const actions: Array<import('playwright-core').Locator> = [];
      for (const frame of page.frames()) {
        throwIfAborted(signal, 'cpi_open_detail');
        let official = false;
        try { official = new URL(frame.url()).hostname === CPI_HOST; } catch { /* URL temporária */ }
        if (!official) continue;
        const buttons = frame.locator('[title="Responder / Atualizar"]');
        for (let i = 0, count = await buttons.count(); i < count; i++) {
          const button = buttons.nth(i);
          const matched = await button.evaluate((element, expected) => {
            const row = element.closest('.row');
            if (!row) return false;
            const numbers = Array.from(row.children)
              .filter(cell => cell.matches('.cell,td,[role="cell"]'))
              .map(cell => ((cell as HTMLElement).innerText ?? '').trim())
              .filter(value => /^[1-9]\d{3,11}$/.test(value));
            return numbers.includes(expected.pesquisaId) && numbers.includes(expected.solicitacaoId);
          }, ids).catch(() => false);
          if (matched) actions.push(button);
        }
      }
      if (actions.length !== 1) throw new Error('Não foi possível vincular de maneira única o botão Responder / Atualizar à solicitação.');
      throwIfAborted(signal, 'cpi_open_detail');
      // Clique nativo do DOM: evita falha de viewport em iframe de layout legado.
      await actions[0].evaluate(element => {
        if (element.getAttribute('title') !== 'Responder / Atualizar') throw new Error('Ação CPI inesperada.');
        (element as HTMLElement).click();
      });
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && !raw) {
        throwIfAborted(signal, 'cpi_open_detail');
        raw = await this.readDetailsFromOpenFrame(ids);
        if (!raw) await page.waitForTimeout(250);
      }
    }
    if (!raw) {
      const diagnostic = await this.detailReadDiagnostic();
      throw new Error(`O detalhe da CPI nao foi reconhecido (${diagnostic}). Nenhuma consulta ou envio foi executado.`);
    }
    endStep('success');
    endStep = timer.begin('cpi_read_cpf');
    const detail=await this.readDetailFrame(ids);
    if(!detail)throw new Error('O formulário CPI mudou durante a validação.');
    const checked = validateCpiPersonDetails(ids, detail.raw);
    throwIfAborted(signal, 'cpi_read_cpf');
    // CPF completo permanece somente na memória do processo principal para uma etapa futura.
    this.lastReadCpf = {ids,cpf:checked.cpf,frame:detail.frame};
    endStep('success');
    return checked.publicDetail;
    });
    } catch (error) { endStep('failed', error); throw error; }
  }

  /** Uso exclusivo do Electron Main; nunca expor o CPF pelo preload/renderer. */
  readValidatedCpf(ids: CpiPendingRowId): string {
    if (this.status().state !== 'open' || !this.lastReadCpf ||
        this.lastReadCpf.ids.pesquisaId !== ids.pesquisaId ||
        this.lastReadCpf.ids.solicitacaoId !== ids.solicitacaoId) {
      throw new Error('Abra e valide os detalhes dessa pesquisa antes de acessar o histórico.');
    }
    return this.lastReadCpf.cpf;
  }

  /** Mesmo parser e seleção de frame para leitura, preenchimento e confirmação. */
  private async readDetailFrame(ids:CpiPendingRowId):Promise<{frame:Frame;raw:CpiRawPersonDetails;dom:CpiDetailDomSnapshot}|null>{
    if(!this.page)return null;
    let frames:Frame[]=[];
    if(await this.page.locator('#sb-container').isVisible().catch(()=>false)){
      try{
        const iframe=await this.page.locator('iframe#sb-content').elementHandle({timeout:500});
        const active=await iframe?.contentFrame();
        if(active)frames=[active];
      }catch{return null;}
    }else frames=this.page.frames();
    const matches:Array<{frame:Frame;raw:CpiRawPersonDetails;dom:CpiDetailDomSnapshot}>=[];
    for(const frame of frames){
      try{
        const url=new URL(frame.url());
        if(url.protocol!=='https:'||url.hostname!==CPI_HOST)continue;
        const dom=await frame.evaluate(readCpiDetailDom);
        const headings=resolveCpiDetailHeadings(dom.titles);
        if(!headings||!matchesCpiDetailHeadings(ids,headings))continue;
        matches.push({frame,dom,raw:{...headings,cpfText:dom.cpfText,pesquisaType:dom.pesquisaType,status:dom.status}});
      }catch{/* Documento em navegação: não usar dados parciais. */}
    }
    return matches.length===1?matches[0]:null;
  }

  private async readDetailsFromOpenFrame(ids:CpiPendingRowId):Promise<CpiRawPersonDetails|null>{
    return (await this.readDetailFrame(ids))?.raw??null;
  }

  private async detailReadDiagnostic(): Promise<string> {
    if (!this.page) return 'navegador indisponivel';
    const modal = await this.page.locator('#sb-container').isVisible().catch(() => false);
    const iframeCount = await this.page.locator('iframe#sb-content').count().catch(() => 0);
    let officialFrame = false;
    let headingsFound = 0;
    if (iframeCount) {
      try {
        const iframe = await this.page.locator('iframe#sb-content').elementHandle({timeout:500});
        const frame = await iframe?.contentFrame();
        if (frame && new URL(frame.url()).hostname === CPI_HOST) {
          officialFrame = true;
          headingsFound = await frame.evaluate(() => {
            const text = (document.body?.innerText ?? '').normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '').toUpperCase();
            return Number(/\bDADOS(?: DA)? SOLICITACAO\b/.test(text)) +
              Number(/\bDADOS DA PESQUISA\b/.test(text));
          });
        }
      } catch { /* nunca retornar dados pessoais em diagnosticos */ }
    }
    return `modal=${modal ? 'visivel' : 'ausente'}, iframe=${iframeCount ? 'presente' : 'ausente'}, ` +
      `frameCPI=${officialFrame ? 'sim' : 'nao'}, titulos=${headingsFound}/2`;
  }
  /** A CPI pode manter o modal aberto e substituir o formulário por uma resposta somente leitura. */
  private async savedResponseEvidence(frame:Frame,ids:CpiPendingRowId,classification:'restrictions'|'information'):Promise<CpiSavedResponseEvidence|null>{
    const current=await this.readDetailFrame(ids);
    if(!current||current.frame!==frame)return null;
    const dom=current.dom;
    const norm=(value:string)=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim().toUpperCase();
    if(norm(dom.savedSource)!=='DESK DATA')return null;
    const result=norm(dom.savedResult);
    const correct=classification==='restrictions'
      ? /^SIM\s*,?\s*CONSTA RESTRICOES$/.test(result)
      : result==='HA INFORMACOES';
    const timestamp=dom.responseTimestamp.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s|$)/);
    const day=Number(timestamp?.[1]),month=Number(timestamp?.[2]),year=Number(timestamp?.[3]);
    const date=new Date(Date.UTC(year,month-1,day));
    const validDate=!!timestamp&&date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day;
    const errors=classifyCpiVisibleServerError(dom.errorSignals);
    return {matchingIds:true,statusRespondida:norm(dom.savedStatus)==='RESPONDIDA',matchingResult:correct,
      hasResponseTimestamp:validDate,
      hasPdfDocument:norm(dom.pdfDocument)==='DOCUMENTO PDF',
      editableUploadPresent:dom.editableUploadPresent,serverErrorVisible:errors.blocking||dom.businessErrorVisible,auxiliary404Observed:errors.auxiliary404};
  }

  /** Reconciliação somente leitura do detalhe aberto manualmente, sem navegar, anexar ou submeter. */
  async inspectPersistedPersonResponse(ids:CpiPendingRowId,classification:'restrictions'|'information',expectedCpf:string):Promise<'confirmed'|'unverified'|'unavailable'>{
    if(!validateCpiRowId(ids)||!isValidCpf(expectedCpf))throw new Error('Identidade CPI inválida para verificação.');
    if(this.status().state!=='open')return 'unavailable';
    // Sem resposta no prazo não há prova de persistência: 'unavailable' (o registro continua bloqueado).
    try{return await this.bounded('cpi_reconcile',this.timeouts.reconcile,signal=>this.inspectPersisted(ids,classification,expectedCpf,signal));}
    catch(error){if(isDeadlineError(error))return 'unavailable';throw error;}
  }
  private async inspectPersisted(ids:CpiPendingRowId,classification:'restrictions'|'information',expectedCpf:string,signal:AbortSignal):Promise<'confirmed'|'unverified'|'unavailable'>{
    const detail=await this.readDetailFrame(ids);
    if(!detail)return 'unavailable';
    if(detail.dom.cpfText&&cpfDigits(detail.dom.cpfText)!==expectedCpf)return 'unverified';
    // O DOM em memória pode ser apenas o resultado de um POST cuja persistência falhou.
    // Reabrir a URL exata por GET e conferir novamente o mesmo frame e os mesmos IDs.
    throwIfAborted(signal,'cpi_reconcile');
    try{await detail.frame.goto(detail.frame.url(),{waitUntil:'domcontentloaded',timeout:15000});}
    catch{return 'unavailable';}
    const refreshed=await this.readDetailFrame(ids);
    if(!refreshed||refreshed.frame!==detail.frame)return 'unverified';
    if(refreshed.dom.cpfText&&cpfDigits(refreshed.dom.cpfText)!==expectedCpf)return 'unverified';
    const evidence=await this.savedResponseEvidence(detail.frame,ids,classification);
    return evidence&&hasConfirmedSavedCpiResponse(evidence)?'confirmed':'unverified';
  }

  /** Fecha somente o modal da pesquisa que já foi confirmada; nunca fecha em envio incerto. */
  async closeCompletedDetail(ids: CpiPendingRowId, listingTimeoutMs = 20000): Promise<void> {
    if (!this.page || this.status().state !== 'open' || !this.lastConfirmedSave ||
        this.lastConfirmedSave.pesquisaId !== ids.pesquisaId ||
        this.lastConfirmedSave.solicitacaoId !== ids.solicitacaoId) {
      throw new Error('Fechamento CPI bloqueado: resposta não confirmada para esta solicitação.');
    }
    const page = this.page;
    const confirmedFrame = this.lastConfirmedSave.frame;
    // Prazo estourado: o chamador mantém a pesquisa em revisão (nunca reenvia) e a listagem é relida no próximo ciclo.
    await this.bounded('cpi_close_detail', this.timeouts.closeDetail, async signal => {
      await this.closeShadowbox(page, ids, confirmedFrame, signal, 'O formulário CPI mudou após a confirmação. Não fechar outro registro.');
      // A CPI pode manter os dados da tabela em cache depois de fechar a Shadowbox.
      // A proxima solicitacao so e liberada apos uma leitura atualizada e estavel.
      await refreshPendingAfterConfirmedSave(page, ids, listingTimeoutMs, signal);
      throwIfAborted(signal, 'cpi_close_detail');
    });
    this.lastFilter = null;
    this.lastMappedRows = [];
    this.lastReadCpf = null;
    this.lastConfirmedSave = null;
  }

  /**
   * Fecha o modal da pesquisa SEM salvar, quando o envio falhou antes do clique em "Alterar" (nada salvo pelo agente).
   * Só fecha o formulário cuja identidade foi lida neste ciclo; nunca depois de uma confirmação ou de envio incerto.
   * Falha aqui deixa o portal bloqueado pelo modal: o chamador trata como parada sistêmica.
   */
  async closeUnsavedDetail(ids: CpiPendingRowId): Promise<void> {
    const frame = this.lastReadCpf?.frame;
    if (!this.page || this.status().state !== 'open' || !frame || this.lastConfirmedSave) {
      throw new Error('Fechamento CPI sem salvar bloqueado: formulário da pesquisa não reconhecido.');
    }
    const page = this.page;
    await this.bounded('cpi_close_detail', this.timeouts.closeDetail, signal =>
      this.closeShadowbox(page, ids, frame, signal, 'O formulário CPI mudou antes de fechar. Não fechar outro registro.'));
    this.lastFilter = null;
    this.lastMappedRows = [];
    this.lastReadCpf = null;
  }
  /** Fecha a Shadowbox da pesquisa pelo controle do portal `a#sb-nav-close` (`Shadowbox.close()`), sem salvar. */
  private async closeShadowbox(page: Page, ids: CpiPendingRowId, expectedFrame: Frame, signal: AbortSignal, frameChanged: string): Promise<void> {
    const modal = page.locator('#sb-container');
    if (!await modal.isVisible().catch(() => false)) return;
    if ((await this.readDetailFrame(ids))?.frame !== expectedFrame) throw new Error(frameChanged);
    const button = page.locator('a#sb-nav-close');
    if (await button.count() !== 1 || !/Shadowbox\.close\s*\(\s*\)/i.test(await button.getAttribute('onclick') ?? '')) {
      throw new Error('Controle único de fechamento da pesquisa CPI não confirmado.');
    }
    throwIfAborted(signal, 'cpi_close_detail');
    await button.evaluate(element => (element as HTMLElement).click());
    await modal.waitFor({state:'hidden',timeout:7000});
  }

  /**
   * Preenche, anexa e salva: anexar → conferir o arquivo no input → `beforeSubmit` (checkpoint `submit_started`)
   * → clicar em "Alterar" → aceitar a confirmação → exigir a resposta correlacionada. Sem reabrir o registro depois.
   * Falha antes do clique devolve `not_submitted` (nada salvo); confirmação divergente, `confirm_mismatch`;
   * só depois do checkpoint o resultado pode ser `unverified`.
   */
  async uploadAndSavePersonResponse(ids: CpiPendingRowId, pdfPath: string, classification: 'restrictions' | 'information', confirmationTimeoutMs=20000, timer: Pick<StepTimer,'begin'> = NULL_TIMER, beforeSubmit: () => Promise<void> = async () => {}): Promise<CpiSaveResult> {
    const progress: SaveProgress = {effectsPossible:false, endStep:null};
    try {
      return await this.bounded('cpi_save', this.timeouts.save + confirmationTimeoutMs, signal =>
        this.saveResponse(ids, pdfPath, classification, confirmationTimeoutMs, timer, signal, progress, beforeSubmit));
    } catch (error) {
      // Só prazo estourado ou cancelamento chegam aqui (o corpo converte as próprias falhas).
      // Nunca repetir: com efeito possível o resultado é incerto ('unverified' → verification_required).
      progress.endStep?.('failed', error);
      return progress.effectsPossible ? 'unverified' : 'not_submitted';
    }
  }
  private async saveResponse(ids: CpiPendingRowId, pdfPath: string, classification: 'restrictions' | 'information', confirmationTimeoutMs: number, timer: Pick<StepTimer,'begin'>, signal: AbortSignal, progress: SaveProgress, beforeSubmit: () => Promise<void>): Promise<CpiSaveResult> {
    let effectsPossible=false;
    let frameReloaded=false;
    let saved=false;
    let failure:unknown;
    let watchedPage:Page|null=null;
    let observeRequest:((request:Request)=>void)|null=null;
    let observeNavigation:((changed:Frame)=>void)|null=null;
    // `progress` é compartilhado com o chamador: no estouro do prazo ele decide sem esperar este corpo.
    const markEffects=():void=>{effectsPossible=true;progress.effectsPossible=true;};
    const beginStep=(step:'cpi_fill'|'cpi_attach'|'cpi_save'):void=>{progress.endStep=timer.begin(step);};
    const label=CPI_RESULT_LABELS[classification];
    try {
    if (!this.page || this.status().state !== 'open') throw saveFailure('CpiDetailError','Sessão CPI indisponível.');
    // Passo 1: o cabeçalho do modal confere pesquisa e solicitação (validateCpiPersonDetails) e o CPF lido no ciclo.
    const detail = await this.readDetailFrame(ids);
    if (!detail) throw saveFailure('CpiDetailError','Detalhes CPI não estão abertos. Não é seguro anexar o PDF.');
    const checked = validateCpiPersonDetails(ids, detail.raw);
    if (checked.cpf !== this.readValidatedCpf(ids)) throw saveFailure('CpiIdentityChangedError','CPF CPI mudou durante o processamento.');
    const page = this.page;
    this.lastConfirmedSave = null;
    const frame=detail.frame;
    if(frame!==this.lastReadCpf?.frame)throw saveFailure('CpiIdentityChangedError','O frame CPI mudou desde a leitura da identidade.');
    beginStep('cpi_fill');
    // Antes do clique em "Alterar", Status e Resultado só chamam funções locais (change_status, change_consta).
    // Só a navegação/recarga do iframe do modal é falha (nada salvo: fecha sem salvar e mantém pdf_ready).
    // XHR/fetch do próprio portal não é motivo de revisão: registra só método e caminho (sem query string).
    watchedPage=page;
    observeRequest=request=>{
      try{
        if(effectsPossible||request.frame()!==frame)return;
        if(request.isNavigationRequest()){frameReloaded=true;return;}
        const type=request.resourceType();
        if(type==='xhr'||type==='fetch')this.reportPortalRequest(request);
      }catch{/* Requisição sem frame não pertence ao formulário. */}
    };
    observeNavigation=changed=>{if(!effectsPossible&&changed===frame)frameReloaded=true;};
    page.on('request',observeRequest);
    page.on('framenavigated',observeNavigation);
    const reloaded=()=>saveFailure('CpiFrameReloadError','O formulário da pesquisa CPI foi recarregado antes do envio; nada foi salvo.');
    const assertIdentity=async()=>{
      if(frameReloaded)throw reloaded();
      const current=await this.readDetailFrame(ids);
      if(frameReloaded)throw reloaded();
      if(!current||current.frame!==frame||current.raw.cpfText.replace(/\D/g,'')!==checked.cpf){
        throw saveFailure('CpiIdentityChangedError','Identidade CPI mudou durante o preenchimento.');
      }
    };
    const single=async(selector:string,name:SaveFailure,message:string)=>{
      const located=frame.locator(selector);
      if(await located.count()!==1)throw saveFailure(name,message);
      return located;
    };
    // Passo 3: Fonte e Fonte 1º = Desk Data; Status = Respondida (change_status revela resultado, editor e arquivo).
    for(const name of ['id_pesquisador','id_pesquisador_prim']){
      const select=await single(`select[name="${name}"]`,'CpiFormFieldError','Campo Pesquisador/Fonte da CPI não identificado de maneira única.');
      await assertIdentity();
      throwIfAborted(signal,'cpi_fill');
      await select.selectOption({label:'Desk Data'},{timeout:10000});
    }
    const status=await single('select[name="id_pesq_status"]','CpiFormFieldError','Campo Status da CPI não identificado de maneira única.');
    await assertIdentity();
    throwIfAborted(signal,'cpi_fill');
    await status.selectOption({label:'Respondida'},{timeout:10000});
    const radio=frame.locator(classification==='restrictions'?'#consta3':'#consta2');
    const files=frame.locator('#MainPage_FileUpload1');
    try{
      await radio.waitFor({state:'visible',timeout:12000});
      await files.waitFor({state:'visible',timeout:12000});
    }catch(error){
      if(frameReloaded)throw reloaded();
      throw saveFailure('CpiResultRadioError','Resultado ou anexo da CPI não apareceram após Status = Respondida; nenhum envio realizado.',error);
    }
    if(await radio.count()!==1||await radio.getAttribute('name')!=='consta')throw saveFailure('CpiResultRadioError','Resultado CPI não identificável; nenhum envio realizado.');
    if(await files.count()!==1)throw saveFailure('CpiFileInputError','Campo único de anexo PDF não confirmado na CPI.');
    const accept=await files.getAttribute('accept');
    if(accept&&!/(?:pdf|\.pdf)/i.test(accept))throw saveFailure('CpiFileInputError','O campo da CPI não permite PDF.');
    // "Alterar": link de texto único que chama upd_pesq() (sem id no portal).
    const links=frame.locator('a');
    const actions:Array<import('playwright-core').Locator>=[];
    for(let i=0,n=await links.count();i<n;i++){
      const link=links.nth(i);
      if((await link.textContent().catch(()=>'')??'').trim()==='Alterar'&&/\bupd_pesq\s*\(\s*\)/.test(await link.getAttribute('onclick').catch(()=>null)??''))actions.push(link);
    }
    if(actions.length!==1)throw saveFailure('CpiSaveButtonError','Link Alterar da CPI não identificado de maneira única.');
    const alterar=actions[0];
    // Passo 4: marcar o resultado e conferir.
    await assertIdentity();
    throwIfAborted(signal,'cpi_fill');
    await radio.check({timeout:5000});
    if(!await radio.isChecked())throw saveFailure('CpiResultRadioError','Resultado CPI não ficou marcado; nenhum envio realizado.');
    progress.endStep?.('success');
    // Passo 5: anexar e conferir o nome do arquivo no input (anexar não envia nada à CPI).
    beginStep('cpi_attach');
    throwIfAborted(signal,'cpi_attach');
    await files.setInputFiles(pdfPath);
    const expectedName=basename(pdfPath);
    const chosen=await files.evaluate(input=>{
      const list=(input as HTMLInputElement).files;
      return list?.length===1?{name:list[0].name,size:list[0].size}:null;
    });
    if(!chosen||chosen.name!==expectedName||chosen.size<100)throw saveFailure('CpiAttachRejectedError','O formulário CPI não confirmou o anexo do PDF esperado.');
    // Passo 6: "Permanecer nesta tela" desmarcado (o modal precisa fechar depois de salvar).
    const stay=frame.locator('#stay');
    if(await stay.count()>1)throw saveFailure('CpiFormFieldError','Opção "Permanecer nesta tela" não identificada de maneira única.');
    if(await stay.count()===1&&await stay.isChecked())await stay.uncheck({timeout:5000});
    if(await stay.count()===1&&await stay.isChecked())throw saveFailure('CpiFormFieldError','Opção "Permanecer nesta tela" não pôde ser desmarcada.');
    if(!await radio.isChecked())throw saveFailure('CpiResultRadioError','Resultado CPI desmarcado antes do envio.');
    await assertIdentity();
    progress.endStep?.('success');
    beginStep('cpi_save');
    // Passo 7: a confirmação só é aceita com o texto do portal e o rótulo esperado; divergente é cancelada.
    let approved=false;
    let mismatch=false;
    let portalAlert=false;
    let sending=false;
    const onDialog=(dialog:import('playwright-core').Dialog)=>{
      const message=dialog.message().replace(/\s+/g,' ');
      if(dialog.type()==='confirm'&&!approved&&!mismatch){
        if(/Deseja Realmente Alterar esta Pesquisa/i.test(message)&&message.includes(`Resultado >>> ${label}`)){
          approved=true;void dialog.accept().catch(()=>{});
        }else{mismatch=true;void dialog.dismiss().catch(()=>{});}
      }else if(dialog.type()==='alert'){
        portalAlert=true;void dialog.accept().catch(()=>{});
      }else void dialog.dismiss().catch(()=>{});
    };
    page.on('dialog',onDialog);
    try {
      throwIfAborted(signal,'cpi_save');
      await assertIdentity();
      // Checkpoint persistido ANTES do clique: daqui em diante qualquer falha é resultado incerto e nunca se repete.
      // Marcado antes de aguardar a gravação: um prazo estourado durante ela já devolve 'unverified'.
      markEffects();
      try { await beforeSubmit(); }
      catch (error) {
        // Falha comprovada antes do clique (o corpo não segue): volta a ser "não enviado".
        effectsPossible=false;progress.effectsPossible=false;
        throw saveFailure('CpiCheckpointError','Checkpoint de envio CPI não gravado; "Alterar" não foi clicado.',error);
      }
      // Operação expirada não clica em salvar (o chamador já devolveu resultado incerto).
      if (signal.aborted) return 'unverified';
      // Passo 8: clicar, aceitar e aguardar o fechamento do modal (#sb-content).
      await alterar.evaluate(link=>(link as HTMLElement).click());
      const modal=page.locator('#sb-container');
      const deadline=Date.now()+confirmationTimeoutMs;
      while(Date.now()<deadline){
        if(signal.aborted)return 'unverified';
        // Cancelada a confirmação divergente, upd_pesq() não envia: revisão manual, sem verification_required.
        if(mismatch&&!approved)return 'confirm_mismatch';
        if(portalAlert)return 'unverified';
        if(approved){
          // "Carregando..." no link: envio em andamento (o link some quando o modal fecha).
          if(!sending)sending=/Carregando/i.test(await alterar.textContent({timeout:300}).catch(()=>'')??'');
          if(!await modal.isVisible().catch(()=>false)){
            this.lastConfirmedSave={...ids,frame};
            saved=true;
            return 'confirmed';
          }
        }
        await page.waitForTimeout(250);
      }
      return 'unverified';
    } finally {
      page.off('dialog',onDialog);
    }
    } catch (error) {
      // A recarga do iframe antes do clique é a causa: falhas seguintes (anexo, campos) são consequência dela.
      failure=frameReloaded&&!effectsPossible&&!(error instanceof Error&&error.name==='CpiFrameReloadError')
        ?saveFailure('CpiFrameReloadError','O formulário da pesquisa CPI foi recarregado antes do envio; nada foi salvo.',error):error;
      // Só a partir do checkpoint (clique possível) o resultado é incerto. Antes dele nada foi salvo pelo agente.
      return effectsPossible?'unverified':'not_submitted';
    } finally {
      if(watchedPage&&observeRequest)watchedPage.off('request',observeRequest);
      if(watchedPage&&observeNavigation)watchedPage.off('framenavigated',observeNavigation);
      progress.endStep?.(saved?'success':'failed',failure);
    }
  }
  /** Registra só método e caminho (sem query string) de XHR/fetch do portal antes do clique. */
  private reportPortalRequest(request:Request):void{
    try{
      const url=new URL(request.url());
      if(url.hostname!==CPI_HOST)return;
      this.diagnostics?.('cpi_portal_request',{method:request.method(),path:url.pathname});
    }catch{/* URL inválida não é registrada. */}
  }

  async close(): Promise<void> {
    // Cancela as operações em curso (param no próximo ponto de verificação) e libera uma nova sessão.
    this.session.abort();
    this.session = new AbortController();
    // Aguarda a criação em curso (com prazo próprio) e não persiste sessão/cookies no disco.
    await this.opening?.catch(() => {});
    const browser = this.browser;
    this.browser = null; this.context = null; this.page = null;
    this.lastFilter = null; this.lastMappedRows = []; this.lastReadCpf = null; this.lastConfirmedSave = null;
    if (browser) await this.closeBrowser(browser);
  }
}

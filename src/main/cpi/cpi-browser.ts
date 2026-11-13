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
interface SaveProgress { effectsPossible: boolean; endStep: EndStep | null }

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
  async closeCompletedDetail(ids: CpiPendingRowId): Promise<void> {
    if (!this.page || this.status().state !== 'open' || !this.lastConfirmedSave ||
        this.lastConfirmedSave.pesquisaId !== ids.pesquisaId ||
        this.lastConfirmedSave.solicitacaoId !== ids.solicitacaoId) {
      throw new Error('Fechamento CPI bloqueado: resposta não confirmada para esta solicitação.');
    }
    const page = this.page;
    const confirmedFrame = this.lastConfirmedSave.frame;
    // Prazo estourado: o chamador mantém a pesquisa em revisão (nunca reenvia) e a listagem é relida no próximo ciclo.
    await this.bounded('cpi_close_detail', this.timeouts.closeDetail, async signal => {
      const modal = page.locator('#sb-container');
      if (await modal.isVisible().catch(() => false)) {
        if((await this.readDetailFrame(ids))?.frame!==confirmedFrame)throw new Error('O formulário CPI mudou após a confirmação. Não fechar outro registro.');
        const title = (await page.locator('#sb-title-inner').innerText({timeout:4000})).trim();
        if (!/Responder\s*\/\s*Atualizar Pesquisa/i.test(title)) {
          throw new Error('Modal CPI inesperado após o salvamento. Fechamento manual necessário.');
        }
        const button = page.locator('#sb-title-inner [title="Fechar"]');
        if (await button.count() !== 1 || !/Shadowbox\.close\s*\(\s*\)/i.test(await button.getAttribute('onclick') ?? '')) {
          throw new Error('Controle único de fechamento da pesquisa CPI não confirmado.');
        }
        throwIfAborted(signal, 'cpi_close_detail');
        await button.evaluate(element => (element as HTMLElement).click());
        await modal.waitFor({state:'hidden',timeout:7000});
      }
      // A CPI pode manter os dados da tabela em cache depois de fechar a Shadowbox.
      // A proxima solicitacao so e liberada apos uma leitura atualizada e estavel.
      await refreshPendingAfterConfirmedSave(page, ids, 20000, signal);
      throwIfAborted(signal, 'cpi_close_detail');
    });
    this.lastFilter = null;
    this.lastMappedRows = [];
    this.lastReadCpf = null;
    this.lastConfirmedSave = null;
  }

  /** Preenche o formulário observado e salva sem reabrir o registro depois. */
  async uploadAndSavePersonResponse(ids: CpiPendingRowId, pdfPath: string, classification: 'restrictions' | 'information', confirmationTimeoutMs=20000, timer: Pick<StepTimer,'begin'> = NULL_TIMER): Promise<'confirmed' | 'confirmed_auxiliary_404' | 'unverified' | 'not_submitted'> {
    const progress: SaveProgress = {effectsPossible:false, endStep:null};
    try {
      return await this.bounded('cpi_save', this.timeouts.save + confirmationTimeoutMs, signal =>
        this.saveResponse(ids, pdfPath, classification, confirmationTimeoutMs, timer, signal, progress));
    } catch (error) {
      // Só prazo estourado ou cancelamento chegam aqui (o corpo converte as próprias falhas).
      // Nunca repetir: com efeito possível o resultado é incerto ('unverified' → verification_required).
      progress.endStep?.('failed', error);
      return progress.effectsPossible ? 'unverified' : 'not_submitted';
    }
  }
  private async saveResponse(ids: CpiPendingRowId, pdfPath: string, classification: 'restrictions' | 'information', confirmationTimeoutMs: number, timer: Pick<StepTimer,'begin'>, signal: AbortSignal, progress: SaveProgress): Promise<'confirmed' | 'confirmed_auxiliary_404' | 'unverified' | 'not_submitted'> {
    let effectsPossible=false;
    let earlyPostback=false;
    let saved=false;
    let watchedPage:Page|null=null;
    let observeEarlyEffects:((request:Request)=>void)|null=null;
    // `progress` é compartilhado com o chamador: no estouro do prazo ele decide sem esperar este corpo.
    // A etapa aberta (progress.endStep) é encerrada como falha no finally se não houve confirmação.
    const markEffects=():void=>{effectsPossible=true;progress.effectsPossible=true;};
    const beginStep=(step:'cpi_fill'|'cpi_attach'|'cpi_save'):void=>{progress.endStep=timer.begin(step);};
    try {
    if (!this.page || this.status().state !== 'open') throw new Error('Sessão CPI indisponível.');
    const detail = await this.readDetailFrame(ids);
    if (!detail) throw new Error('Detalhes CPI não estão abertos. Não é seguro anexar o PDF.');
    const checked = validateCpiPersonDetails(ids, detail.raw);
    if (checked.cpf !== this.readValidatedCpf(ids)) throw new Error('CPF CPI mudou durante o processamento.');
    const page = this.page;
    this.lastConfirmedSave = null;
    const frame=detail.frame;
    if(frame!==this.lastReadCpf?.frame)throw new Error('O frame CPI mudou desde a leitura da identidade.');
    beginStep('cpi_fill');
    // Mudanças em controles também podem disparar postbacks no portal legado.
    watchedPage=page;
    observeEarlyEffects=request=>{
      try{if(request.frame()===frame&&(request.method()==='POST'||request.isNavigationRequest())){markEffects();earlyPostback=true;}}
      catch{/* Requisição sem frame não fornece prova de ausência de efeitos. */}
    };
    page.on('request',observeEarlyEffects);
    const assertIdentity=async()=>{
      if(earlyPostback)throw new Error('Postback CPI observado antes do salvamento; resultado incerto.');
      const current=await this.readDetailFrame(ids);
      if(earlyPostback||!current||current.frame!==frame||current.raw.cpfText.replace(/\D/g,'')!==checked.cpf){
        throw new Error('Identidade CPI mudou durante o preenchimento.');
      }
    };
    // Localizar selects pela linha de rótulo; nunca assumir índice global ou valor HTML desconhecido.
    const selectFor = async (name: RegExp) => {
      const selects = frame.locator('select');
      const matched: Array<import('playwright-core').Locator> = [];
      for (let i = 0, n = await selects.count(); i < n; i++) {
        const element = selects.nth(i);
        const label = await element.evaluate(select => {
          const row = select.closest('.row');
          const cell = row?.querySelector('.cell');
          return cell?.textContent?.trim() ?? '';
        }).catch(() => '');
        if (name.test(label.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) matched.push(element);
      }
      if (matched.length !== 1) throw new Error('Campo obrigatório da CPI não identificado de maneira única.');
      return matched[0];
    };
    const source = await selectFor(/Pesquisador\/Fonte\s*:/i);
    await assertIdentity();
    throwIfAborted(signal, 'cpi_fill');
    await source.selectOption({ label: 'Desk Data' }, { timeout: 10000 });
    await assertIdentity();
    const status = await selectFor(/^Status\s*:/i);
    await assertIdentity();
    throwIfAborted(signal, 'cpi_fill');
    await status.selectOption({ label: 'Respondida' }, { timeout: 10000 });
    // O portal exibe controles de resultado após a alteração do status.
    const resultName = classification === 'restrictions' ? 'Sim, Consta Restrições' : 'Há Informações';
    const radioDeadline = Date.now() + 12000;
    let selected = false;
    while (Date.now() < radioDeadline && !selected) {
      throwIfAborted(signal, 'cpi_fill');
      await assertIdentity();
      selected = await frame.locator('input[type="radio"]').evaluateAll((nodes, requested) => {
        const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
        const target = norm(requested);
        const candidates = nodes.filter(node => {
          const input = node as HTMLInputElement;
          const row = input.closest('.row');
          if (!row || !/RESULTADO\s*:/i.test(norm(row.textContent ?? ''))) return false;
          const labelled = input.labels?.[0]?.textContent ?? input.closest('label')?.textContent ?? '';
          let near = '';
          let sibling: ChildNode | null = input.nextSibling;
          // Alguns formulários antigos usam texto solto após cada radio, sem <label>.
          for (let i = 0; sibling && i < 5; i++, sibling = sibling.nextSibling) {
            if (sibling.nodeType === Node.ELEMENT_NODE &&
                (sibling as Element).matches('input[type="radio"]')) break;
            near += sibling.textContent ?? '';
            if (norm(near) === target) break;
          }
          const nextLabel = input.nextElementSibling?.textContent ?? '';
          return [labelled, near, nextLabel].some(value => norm(value) === target);
        }) as HTMLInputElement[];
        if (candidates.length !== 1 || candidates[0].disabled) return false;
        if (!candidates[0].checked) candidates[0].click();
        return candidates[0].checked;
      }, resultName).catch(() => false);
      if (!selected) await page.waitForTimeout(250);
    }
    if (!selected) throw new Error('Resultado CPI não identificável; nenhum envio realizado.');
    const files = frame.locator('input[type="file"]');
    await files.first().waitFor({state:'attached',timeout:12000}).catch(() => {});
    if (await files.count() !== 1) throw new Error('Campo único de anexo PDF não confirmado na CPI.');
    const accept = await files.getAttribute('accept');
    if (accept && !/(?:pdf|\.pdf)/i.test(accept)) throw new Error('O campo da CPI não permite PDF.');
    // Conferir formulário e ação antes de fornecer o arquivo a handlers do portal.
    const saveCandidates = frame.locator('a.button,button,input[type="submit"]');
    const actions: Array<import('playwright-core').Locator> = [];
    for (let i = 0, n = await saveCandidates.count(); i < n; i++) {
      const candidate = saveCandidates.nth(i);
      if ((await candidate.textContent().catch(() => '') ?? '').trim() === 'Alterar' ||
          await candidate.getAttribute('value').catch(() => null) === 'Alterar') actions.push(candidate);
    }
    if (actions.length !== 1) throw new Error('Botão Alterar CPI não identificado de maneira única.');
    const form=await files.evaluate(input=>{
      const form=(input as HTMLInputElement).form;
      return form?{action:form.action,method:form.method}:null;
    });
    if(!form||form.method.toLowerCase()!=='post')throw new Error('Formulário de envio CPI não confirmado.');
    const actionUrl=new URL(form.action);
    if(actionUrl.protocol!=='https:'||actionUrl.hostname!==CPI_HOST||
      actionUrl.searchParams.getAll('id_sol').length!==1||actionUrl.searchParams.get('id_sol')!==ids.solicitacaoId||
      actionUrl.searchParams.getAll('id_pesq_tipo').length!==1||actionUrl.searchParams.get('id_pesq_tipo')!==ids.pesquisaId){
      throw new Error('Ação do formulário CPI não corresponde aos IDs validados.');
    }
    actionUrl.hash='';
    if(!await actions[0].evaluate(button=>button.closest('form')===document.querySelector('input[type="file"]')?.closest('form'))){
      throw new Error('Botão de salvamento e PDF pertencem a formulários diferentes.');
    }
    await assertIdentity();
    progress.endStep?.('success');
    beginStep('cpi_attach');
    // Último ponto sem efeito possível: depois daqui um prazo estourado vira resultado incerto.
    throwIfAborted(signal, 'cpi_attach');
    markEffects();
    await files.setInputFiles(pdfPath);
    const attached = await files.evaluate(input => {
      const chosen = (input as HTMLInputElement).files;
      return chosen?.length === 1 && /\.pdf$/i.test(chosen[0].name) && chosen[0].size > 100;
    });
    if (!attached) throw new Error('O formulário CPI não confirmou o anexo PDF.');
    await assertIdentity();
    progress.endStep?.('success');
    beginStep('cpi_save');
    let approvedConfirm = false;
    let httpSubmitted = false;
    let armed=false;
    let submittedRequest:Request|null=null;
    let navigated=false;
    let portalAlertFailure = false;
    let portalHttpFailure = false;
    const onRequest=(request:Request)=>{
      try{
        const url=new URL(request.url());url.hash='';
        if(!armed||request.frame()!==frame||!request.isNavigationRequest())return;
        // Outro documento (inclusive GET para a mesma URL) invalida a correlação.
        if(submittedRequest||request.method()!=='POST'||url.href!==actionUrl.href)portalHttpFailure=true;
        else submittedRequest=request;
      }catch{/* Requisição sem frame não é evidência. */}
    };
    const onNavigation=(changed:Frame)=>{
      if(armed&&submittedRequest&&changed===frame){
        if(navigated)portalHttpFailure=true;
        navigated=true;
      }
    };
    const onResponse = (response: import('playwright-core').Response) => {
      try {
        if (response.request()===submittedRequest) {
          if (response.status() >= 200 && response.status() < 300) httpSubmitted = true;
          else portalHttpFailure = true;
        }
      } catch { /* resposta não pertinente */ }
    };
    const onDialog = (dialog: import('playwright-core').Dialog) => {
      if (dialog.type() === 'confirm' && /alterar esta pesquisa/i.test(dialog.message())) {
        approvedConfirm = true;
        void dialog.accept().catch(() => {});
      } else if (dialog.type() === 'alert') {
        if (/(?:erro|falha|inv[aá]lid|n[aã]o foi poss[ií]vel|n[aã]o autorizado)/i.test(dialog.message())) portalAlertFailure = true;
        void dialog.accept().catch(() => {});
      } else {
        void dialog.dismiss().catch(() => {});
      }
    };
    page.on('request',onRequest);
    page.on('framenavigated',onNavigation);
    page.on('response', onResponse);
    page.on('dialog', onDialog);
    try {
      // Operação expirada não clica em salvar (o chamador já devolveu resultado incerto).
      if (signal.aborted) return 'unverified';
      armed=true;
      await actions[0].evaluate((button,expectedAction) => {
        const form=button.closest('form');
        const action=form?new URL(form.action):null;
        if(action)action.hash='';
        if(!form||form.method.toLowerCase()!=='post'||action?.href!==expectedAction)throw new Error('Ação CPI alterada antes do clique.');
        (button as HTMLElement).click();
      },actionUrl.href);
      const deadline=Date.now()+confirmationTimeoutMs;
      while(Date.now()<deadline) {
        if (signal.aborted || portalAlertFailure || portalHttpFailure) return 'unverified';
        const responseUrl=new URL(frame.url());responseUrl.hash='';
        if (approvedConfirm && httpSubmitted && navigated && responseUrl.href===actionUrl.href) {
          const evidence = await this.savedResponseEvidence(frame,ids, classification);
          if (!signal.aborted && !portalHttpFailure && !portalAlertFailure && evidence && hasConfirmedSavedCpiResponse(evidence)) {
            this.lastConfirmedSave = {...ids,frame};
            saved=true;
            return evidence.auxiliary404Observed ? 'confirmed_auxiliary_404' : 'confirmed';
          }
        }
        await page.waitForTimeout(300);
      }
      return 'unverified';
    } finally {
      page.off('response', onResponse);
      page.off('dialog', onDialog);
      page.off('request',onRequest);
      page.off('framenavigated',onNavigation);
    }
    } catch {
      // A partir da tentativa de anexar, um handler do portal pode ter produzido efeitos.
      return effectsPossible?'unverified':'not_submitted';
    } finally {
      if(watchedPage&&observeEarlyEffects)watchedPage.off('request',observeEarlyEffects);
      progress.endStep?.(saved?'success':'failed');
    }
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

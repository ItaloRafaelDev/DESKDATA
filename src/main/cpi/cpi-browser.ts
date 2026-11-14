import { chromium, type Browser, type BrowserContext, type Page, type Frame, type Request } from 'playwright-core';
import { filterPendingPerson29, readListingCount, type CpiPendingFilterResult } from './pending-filter.ts';
import { inspectPendingPerson29Rows, validateCpiRowId, type CpiPendingRowId, type CpiPendingRowsInspection } from './pending-rows.ts';
import { validateCpiPersonDetails, resolveCpiDetailHeadings, matchesCpiDetailHeadings, readCpiDetailDom, type CpiDetailDomSnapshot, type CpiRawPersonDetails, type CpiPendingPersonDetail } from './pending-details.ts';
import { classifyCpiHttpResponse, classifyCpiVisibleServerError, hasConfirmedSavedCpiResponse, judgeSavedCpiResponse, savedResponseEvidenceFromDom,
  type CpiFinalizeReport, type CpiPersistenceVerdict, type CpiSavedResponseEvidence } from './response-confirmation.ts';
import { refreshPendingAfterConfirmedSave } from './pending-refresh.ts';
import { basename } from 'node:path';
import { cpfDigits, isValidCpf } from '../../shared/cpf.ts';
import { CPI_FORM, resultSelectorFor, type CpiResultClassification } from './form-selectors.ts';
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
  detail: 45_000, save: 60_000, closeDetail: 75_000, reconcile: 45_000,
  /** Leitura independente (GET em aba transitória) da resposta salva, antes de concluir. */
  verifySave: 30_000,
  /** Espera por um campo do formulário de resposta (ex.: radios que surgem após o Status). */
  fieldWait: 10_000,
  /** Leitura da visibilidade do modal para a liberação operacional (falha ou estouro = aberto). */
  modalState: 3_000
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
  /** Envio aceito pelo formulário (ainda sem prova de persistência) e o que é preciso para conferi-lo. */
  private lastConfirmedSave: (CpiPendingRowId & {frame:Frame;url:string;cpf:string;classification:CpiResultClassification;auxiliary404:boolean}) | null = null;
  /** Abortado por `close()`: toda operação em curso para no próximo ponto de verificação. */
  private session = new AbortController();
  /** Pendência operacional (motivo exibível, sem dados pessoais): janela de pesquisa submetida ainda aberta. */
  private operationalHold: string | null = null;
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
      browser.on('disconnected', () => { if (this.browser === browser) { this.browser = null; this.context = null; this.page = null; this.lastFilter = null; this.lastMappedRows = []; this.lastReadCpf = null; this.lastConfirmedSave = null; this.operationalHold = null; } });
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
  async filterPendingPerson29(timer:Pick<StepTimer,'step'>=NULL_TIMER): Promise<CpiPendingFilterResult> {
    if (this.status().state !== 'open' || !this.page) throw new Error('Abra e autentique primeiro o navegador CPI.');
    this.lastFilter = null;
    this.lastMappedRows = [];
    this.lastReadCpf = null;
    this.lastConfirmedSave = null;
    const page = this.page;
    return this.bounded('cpi_filter', this.timeouts.filter, async signal => {
      await timer.step('cpi_filter_modal',async()=>{
        await this.assertOperationalRelease(signal);
        if (await this.modalOpen(page,signal)) {
          this.operationalHold = 'uma janela modal já estava aberta antes do filtro; o portal precisa voltar à listagem.';
          this.lastFilter = null; this.lastMappedRows = []; this.lastReadCpf = null; this.lastConfirmedSave = null;
          throw new Error(`Pendência operacional CPI: ${this.operationalHold} Feche a janela manualmente na CPI antes de continuar; nenhuma pesquisa será aberta até lá.`);
        }
      });
      const result = await filterPendingPerson29(page, signal, timer);
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
    await this.assertOperationalRelease();
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
    await this.assertOperationalRelease();
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
    return savedResponseEvidenceFromDom(current.dom,classification);
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

  /** Prova final pela listagem; injetável em testes (o fixture do formulário não tem listagem real). */
  private refreshAfterSave: typeof refreshPendingAfterConfirmedSave = refreshPendingAfterConfirmedSave;

  /** Fecha a Shadowbox "Responder / Atualizar Pesquisa" pelo controle único do portal; nunca fecha duas vezes. */
  private async closeShadowbox(page: Page, signal: AbortSignal, label: string): Promise<'closed'|'already_hidden'> {
    const modal = page.locator('#sb-container');
    // Leitura que falha não prova modal fechado: segue para a validação do título e do controle único.
    if (!await this.modalOpen(page, signal)) return 'already_hidden';
    const title = (await page.locator('#sb-title-inner').innerText({timeout:4000})).trim();
    if (!/Responder\s*\/\s*Atualizar Pesquisa/i.test(title)) {
      throw new Error('Modal CPI inesperado. Fechamento manual necessário.');
    }
    const button = page.locator('#sb-title-inner [title="Fechar"]');
    if (await button.count() !== 1 || !/Shadowbox\.close\s*\(\s*\)/i.test(await button.getAttribute('onclick') ?? '')) {
      throw new Error('Controle único de fechamento da pesquisa CPI não confirmado.');
    }
    throwIfAborted(signal, label);
    await button.evaluate(element => (element as HTMLElement).click());
    await modal.waitFor({state:'hidden',timeout:7000});
    return 'closed';
  }

  /**
   * Prova independente de persistência: GET da URL exata do formulário em uma aba transitória do mesmo
   * contexto, sem tocar no modal, sem POST e sem clicar em nada. Confere IDs, CPF (quando exibido),
   * Status, classificação, data, fonte e a indicação "Documento PDF". O 404 conhecido de cpi_api_request.aspx
   * é só aviso; outra falha desse recurso torna a leitura indisponível.
   * Limite: "Documento PDF" é o texto exibido pelo portal. Não há identificador, nome, hash ou tamanho do anexo
   * conferível só por leitura; o arquivo não é baixado nem aberto. A conclusão afirma a indicação, não o arquivo.
   */
  private async probePersisted(page: Page, saved: NonNullable<CpiBrowser['lastConfirmedSave']>, signal: AbortSignal): Promise<{verdict:CpiPersistenceVerdict;auxiliary404:boolean}> {
    let auxiliary404 = false, auxiliaryFailed = false;
    const probe = await page.context().newPage();
    probe.on('response', response => {
      try {
        const request = response.request();
        const verdict = classifyCpiHttpResponse({url:response.url(),status:response.status(),
          mainDocument:request.frame() === probe.mainFrame() && request.isNavigationRequest()});
        if (verdict === 'auxiliary_404') auxiliary404 = true;
        else if (verdict === 'auxiliary_failed') auxiliaryFailed = true;
      } catch { /* resposta não pertinente */ }
    });
    try {
      throwIfAborted(signal, 'cpi_verify_save');
      const response = await probe.goto(saved.url, {waitUntil:'domcontentloaded', timeout:15000}).catch(() => null);
      if (!response || classifyCpiHttpResponse({url:response.url(),status:response.status(),mainDocument:true}) === 'main_failed') return {verdict:'unavailable',auxiliary404};
      await probe.waitForLoadState('load', {timeout:5000}).catch(() => undefined);
      // Requisições assíncronas (como cpi_api_request.aspx) podem responder depois do `load`: aguardar a rede
      // ociosa, com prazo, para que uma falha auxiliar tardia não passe despercebida.
      await probe.waitForLoadState('networkidle', {timeout:4000}).catch(() => undefined);
      throwIfAborted(signal, 'cpi_verify_save');
      if (auxiliaryFailed) return {verdict:'unavailable',auxiliary404};
      const loaded = new URL(probe.url());
      if (loaded.protocol !== 'https:' || loaded.hostname !== CPI_HOST || loaded.pathname.toLowerCase() === CPI_FORM.loginPath ||
          loaded.searchParams.get('id_sol') !== saved.solicitacaoId || loaded.searchParams.get('id_pesq_tipo') !== saved.pesquisaId) {
        return {verdict:'unavailable',auxiliary404};
      }
      const dom = await probe.mainFrame().evaluate(readCpiDetailDom);
      const headings = resolveCpiDetailHeadings(dom.titles);
      if (!headings || !matchesCpiDetailHeadings(saved, headings) || (dom.cpfText && cpfDigits(dom.cpfText) !== saved.cpf)) {
        return {verdict:'unavailable',auxiliary404};
      }
      const evidence = savedResponseEvidenceFromDom(dom, saved.classification);
      // Reconferido após a leitura: falha auxiliar que chegou durante a avaliação também invalida.
      if (auxiliaryFailed) return {verdict:'unavailable',auxiliary404};
      return {verdict:judgeSavedCpiResponse(evidence),auxiliary404:auxiliary404||evidence.auxiliary404Observed};
    } finally {
      await probe.close().catch(() => undefined);
      await page.bringToFront().catch(() => undefined);
    }
  }

  /**
   * Depois de um envio aceito pelo formulário, em três fases independentes:
   * 1. persistência: leitura independente da resposta salva (único critério para concluir);
   * 2. modal: se o portal já fechou, nada é clicado; se continua aberto, fecha pelo controle `Shadowbox.close()`;
   * 3. listagem: "Mostrar Tudo" e conferência de que a pesquisa saiu da lista (efeito visual).
   * Falhas de modal ou listagem não alteram o veredito de persistência e nunca levam a reenvio.
   * Sem persistência comprovada o modal fica como está, para a verificação manual.
   */
  async finalizeSubmittedResponse(ids: CpiPendingRowId): Promise<CpiFinalizeReport> {
    const saved = this.lastConfirmedSave;
    if (!this.page || this.status().state !== 'open' || !saved ||
        saved.pesquisaId !== ids.pesquisaId || saved.solicitacaoId !== ids.solicitacaoId) {
      throw new Error('Fechamento CPI bloqueado: resposta não confirmada para esta solicitação.');
    }
    const page = this.page;
    // Uma única conferência por envio: o estado é consumido mesmo em falha.
    this.lastFilter = null; this.lastMappedRows = []; this.lastReadCpf = null; this.lastConfirmedSave = null;
    let probe: {verdict:CpiPersistenceVerdict;auxiliary404:boolean};
    try { probe = await this.bounded('cpi_verify_save', this.timeouts.verifySave, signal => this.probePersisted(page, saved, signal)); }
    catch { probe = {verdict:'unavailable', auxiliary404:false}; }
    const auxiliary404 = saved.auxiliary404 || probe.auxiliary404;
    if (probe.verdict !== 'confirmed') {
      // Modal preservado para a verificação manual: o navegador fica retido até o operador fechá-lo.
      const browserReleased = await this.releaseUnlessModalOpen(page, 'envio sem persistência comprovada; a janela da pesquisa foi mantida para verificação manual.');
      return {persistence:probe.verdict, auxiliary404, modal:'not_attempted', listing:'not_attempted', browserReleased};
    }
    let modal: CpiFinalizeReport['modal'] = 'close_failed';
    let listing: CpiFinalizeReport['listing'] = 'not_attempted';
    try {
      await this.bounded('cpi_close_detail', this.timeouts.closeDetail, async signal => {
        // Após o POST o iframe pode exibir outro documento: não exigir mais o formulário original aqui.
        modal = await this.closeShadowbox(page, signal, 'cpi_close_detail') === 'closed' ? 'closed' : 'auto_closed';
        listing = 'stale';
        await this.refreshAfterSave(page, ids, 20000, signal);
        throwIfAborted(signal, 'cpi_close_detail');
        listing = 'refreshed';
      });
    } catch { /* Efeito visual: o veredito de persistência já está decidido. */ }
    // Liberação operacional separada da persistência: o estado do modal é relido, sem confiar no resultado do clique.
    const browserReleased = await this.releaseUnlessModalOpen(page, 'resposta confirmada na CPI, mas a janela da pesquisa continua aberta.');
    return {persistence:'confirmed', auxiliary404, modal, listing, browserReleased};
  }

  /** Lê a visibilidade do modal com prazo próprio; falha ou estouro contam como aberto (fail-closed). */
  private async modalOpen(page: Page, signal?:AbortSignal): Promise<boolean> {
    try { return await runWithDeadline('cpi_modal_state',this.timeouts.modalState,
      ()=>page.locator('#sb-container').isVisible(),signal); }
    catch(error) { if(signal?.aborted)throw error;return true; }
  }
  /** Retém o navegador (pendência operacional) se o modal continua aberto; devolve se ficou liberado. */
  private async releaseUnlessModalOpen(page: Page, reason: string): Promise<boolean> {
    if (!await this.modalOpen(page)) return true;
    this.operationalHold = reason;
    // Sem identidade nem listagem reutilizáveis: um novo envio exigiria reabrir o detalhe, que está bloqueado.
    this.lastFilter = null; this.lastMappedRows = []; this.lastReadCpf = null;
    return false;
  }
  /**
   * Pendência operacional: nenhuma leitura de listagem, abertura de pesquisa ou envio enquanto a janela de uma
   * pesquisa já submetida continuar aberta. Liberada sozinha quando o modal some (fechado pelo operador) ou ao
   * fechar o navegador; nunca reabre a pesquisa nem repete POST, anexo ou consulta.
   */
  private async assertOperationalRelease(signal?:AbortSignal): Promise<void> {
    const reason = this.operationalHold;
    if (!reason) return;
    if (this.page && this.status().state === 'open' && !await this.modalOpen(this.page,signal)) { this.operationalHold = null; return; }
    throw new Error(`Pendência operacional CPI: ${reason} Feche a janela manualmente na CPI antes de continuar; nenhuma pesquisa será aberta até lá.`);
  }

  /** Modo ensaio: fecha o formulário ainda não salvo da mesma pesquisa, sem enviar nada. */
  async closeDetailWithoutSaving(ids: CpiPendingRowId): Promise<void> {
    if (!this.page || this.status().state !== 'open') throw new Error('Sessão CPI indisponível.');
    const page = this.page;
    await this.bounded('cpi_close_detail', this.timeouts.closeDetail, async signal => {
      if (await this.modalOpen(page, signal) && !await this.readDetailFrame(ids)) {
        throw new Error('O formulário aberto não corresponde à pesquisa ensaiada. Fechamento manual necessário.');
      }
      await this.closeShadowbox(page, signal, 'cpi_close_detail');
    });
    this.lastFilter = null;
    this.lastMappedRows = [];
    this.lastReadCpf = null;
    this.lastConfirmedSave = null;
  }

  /**
   * Preenche e salva a resposta seguindo a sequência validada no portal real:
   * Status → aguardar radios → Fonte → Resultado (pelo rótulo) → conferir → anexar PDF → conferir → Alterar → OK.
   * `dry_run` faz tudo, mas cancela o diálogo de confirmação (nada é salvo).
   */
  async uploadAndSavePersonResponse(ids: CpiPendingRowId, pdfPath: string, classification: CpiResultClassification, confirmationTimeoutMs=20000, timer: Pick<StepTimer,'begin'> = NULL_TIMER, mode: 'save'|'dry_run' = 'save'): Promise<'confirmed' | 'confirmed_auxiliary_404' | 'unverified' | 'not_submitted' | 'not_submitted_held' | 'dry_run_ok'> {
    // Sem verificação de pendência aqui: o envio exige o CPF lido por `inspectPendingPersonDetails` (que verifica),
    // e a pendência descarta essa leitura. Recusar aqui viraria verificação manual de algo nunca enviado.
    const progress: SaveProgress = {effectsPossible:false, endStep:null};
    let result: Awaited<ReturnType<CpiBrowser['saveResponse']>>;
    try {
      result = await this.bounded('cpi_save', this.timeouts.save + confirmationTimeoutMs, signal =>
        this.saveResponse(ids, pdfPath, classification, confirmationTimeoutMs, timer, signal, progress, mode));
    } catch (error) {
      // Só prazo estourado ou cancelamento chegam aqui (o corpo converte as próprias falhas).
      // Nunca repetir: com efeito possível o resultado é incerto ('unverified' → verification_required).
      progress.endStep?.('failed', error);
      result = progress.effectsPossible ? 'unverified' : 'not_submitted';
    }
    // Envio incerto com a janela aberta: o navegador fica retido até o operador conferir e fechar.
    if (result === 'unverified' && this.page) await this.releaseUnlessModalOpen(this.page, 'envio sem confirmação; a janela da pesquisa foi mantida para verificação manual.');
    if (result === 'not_submitted' && this.page && !await this.releaseUnlessModalOpen(this.page,
      'nenhum envio foi realizado, mas a janela da pesquisa continua aberta e precisa ser fechada manualmente.')) {
      return 'not_submitted_held';
    }
    return result;
  }

  /** Exatamente um controle para o seletor, aguardando a renderização (polling de 250 ms). */
  private async singleControl(frame: Frame, selector: string, timeoutMs: number, signal: AbortSignal, label: string): Promise<import('playwright-core').Locator> {
    const control = frame.locator(selector);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      throwIfAborted(signal, label);
      const count = await control.count().catch(() => 0);
      if (count === 1) return control;
      if (count > 1) throw new Error(`Campo da CPI duplicado (${selector}).`);
      if (Date.now() >= deadline) throw new Error(`Campo da CPI não apareceu (${selector}).`);
      await frame.page().waitForTimeout(250);
    }
  }

  /** Texto da opção selecionada, sem asteriscos e com espaços normalizados. */
  private async selectedLabel(frame: Frame, selector: string): Promise<string> {
    const option = frame.locator(`${selector} option:checked`);
    if (await option.count().catch(() => 0) !== 1) return '';
    return (await option.innerText({timeout:3000}).catch(() => '')).replace(/\*/g, '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Aplica Status, Fonte e Resultado e confere os três. A troca de Status pode recarregar o bloco do
   * formulário (zerando a Fonte), por isso a sequência é reaplicada até 3 vezes antes de desistir.
   */
  private async prepareForm(frame: Frame, classification: CpiResultClassification, signal: AbortSignal): Promise<void> {
    const resultSelector = resultSelectorFor(classification);
    const resultId = resultSelector.slice(1);
    for (let attempt = 1; attempt <= 3; attempt++) {
      throwIfAborted(signal, 'cpi_fill');
      const status = await this.singleControl(frame, CPI_FORM.status, this.timeouts.fieldWait, signal, 'cpi_fill');
      if (await this.selectedLabel(frame, CPI_FORM.status) !== CPI_FORM.statusLabel) {
        await status.selectOption({ label: CPI_FORM.statusLabel }, { timeout: 10000 });
      }
      // Os radios de Resultado só existem depois que o Status vira Respondida.
      const radio = await this.singleControl(frame, resultSelector, this.timeouts.fieldWait, signal, 'cpi_fill');
      const source = await this.singleControl(frame, CPI_FORM.source, this.timeouts.fieldWait, signal, 'cpi_fill');
      if (await this.selectedLabel(frame, CPI_FORM.source) !== CPI_FORM.sourceLabel) {
        await source.selectOption({ label: CPI_FORM.sourceLabel }, { timeout: 10000 });
      }
      if (!await radio.isChecked().catch(() => false)) {
        const label = frame.locator(`label[for="${resultId}"]`);
        if (await label.count().catch(() => 0) === 1) await label.click({ timeout: 5000 }).catch(() => undefined);
        if (!await radio.isChecked().catch(() => false)) await radio.check({ force: true, timeout: 5000 }).catch(() => undefined);
      }
      // "Permanecer nesta tela" deve ficar desmarcado para a CPI voltar à lista após salvar.
      await frame.evaluate(text => {
        const norm = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
        for (const box of Array.from(document.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[]) {
          const near = [box.labels?.[0]?.textContent ?? '', box.closest('label')?.textContent ?? '',
            box.nextSibling?.textContent ?? '', box.parentElement?.textContent ?? ''].map(norm);
          if (near.some(value => value === text || (value.includes(text) && value.length <= text.length + 10)) && box.checked) box.click();
        }
      }, CPI_FORM.keepOnScreenText).catch(() => undefined);
      await frame.page().waitForTimeout(200);
      const forbiddenChecked = await Promise.all(CPI_FORM.resultForbidden.map(selector =>
        frame.locator(selector).isChecked().catch(() => false)));
      if (await this.selectedLabel(frame, CPI_FORM.status) === CPI_FORM.statusLabel &&
          await this.selectedLabel(frame, CPI_FORM.source) === CPI_FORM.sourceLabel &&
          await radio.isChecked().catch(() => false) && !forbiddenChecked.some(Boolean)) return;
    }
    throw new Error('Os campos da CPI não permaneceram estáveis (Fonte, Status ou Resultado). Nenhum envio realizado.');
  }

  /**
   * Espera o formulário ser deixado após o OK: o iframe navega (resposta do POST) ou some, ou a Shadowbox
   * fecha. Login, HTTP de erro, alert de erro ou texto de erro na resposta tornam o envio incerto.
   */
  private async waitForFormExit(page: Page, frame: Frame, state: {navigated:boolean;failed:boolean;auxiliary404:boolean}, timeoutMs: number, signal: AbortSignal): Promise<'left'|'failed'|'timeout'> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      throwIfAborted(signal, 'cpi_save');
      if (state.failed) return 'failed';
      // Leitura que falha conta como aberto: sem evidência continua aguardando e, no prazo, fica 'unverified'.
      const modalVisible = await this.modalOpen(page, signal);
      if (state.navigated || frame.isDetached() || !modalVisible) {
        // Pequena janela para alert de erro disparado pela página de resposta.
        await page.waitForTimeout(1200);
        if (state.failed) return 'failed';
        if (!frame.isDetached()) {
          try {
            const current = new URL(frame.url());
            // Página de erro do navegador, outro domínio ou login: a resposta do POST não é do portal autenticado.
            if (current.protocol !== 'https:' || current.hostname !== CPI_HOST ||
                current.pathname.toLowerCase() === CPI_FORM.loginPath) return 'failed';
            // N\u00f3s de texto separados e sem <script>/<style>: com o modal oculto, innerText vira textContent
            // e colaria o c\u00f3digo do script ao texto do erro, escondendo o 404 auxiliar.
            const text = await frame.evaluate(() => {
              const parts: string[] = [];
              if (document.body) {
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                  if (!node.parentElement?.closest('script,style,noscript,template')) parts.push(node.nodeValue ?? '');
                }
              }
              return parts.join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().slice(0, 20000);
            });
            // Erro de servidor s\u00f3 bloqueia quando n\u00e3o \u00e9 o 404 conhecido do recurso auxiliar cpi_api_request.aspx.
            const server = classifyCpiVisibleServerError(text);
            if (server.auxiliary404) state.auxiliary404 = true;
            if (server.blocking || /(?:ERRO|FALHA)\s+(?:AO|NO|NA)\s|NAO FOI POSSIVEL|NAO AUTORIZADO/.test(text)) return 'failed';
          } catch { /* Documento em troca: a prova final é a listagem. */ }
        }
        return 'left';
      }
      await page.waitForTimeout(250);
    }
    return 'timeout';
  }

  private async saveResponse(ids: CpiPendingRowId, pdfPath: string, classification: CpiResultClassification, confirmationTimeoutMs: number, timer: Pick<StepTimer,'begin'>, signal: AbortSignal, progress: SaveProgress, mode: 'save'|'dry_run'): Promise<'confirmed' | 'confirmed_auxiliary_404' | 'unverified' | 'not_submitted' | 'dry_run_ok'> {
    let saved=false;
    let rehearsed=false;
    let watchedPage:Page|null=null;
    let observeAfterAttach:((request:Request)=>void)|null=null;
    // Efeito remoto só é possível depois de um POST/navegação do frame (após anexar) ou do clique em Alterar.
    const markEffects=():void=>{progress.effectsPossible=true;};
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
    // A URL real do formulário carrega os IDs (mesmo formato lido no onclick da listagem).
    const frameUrl=new URL(frame.url());
    if(frameUrl.protocol!=='https:'||frameUrl.hostname!==CPI_HOST||
      frameUrl.searchParams.getAll('id_sol').length!==1||frameUrl.searchParams.get('id_sol')!==ids.solicitacaoId||
      frameUrl.searchParams.getAll('id_pesq_tipo').length!==1||frameUrl.searchParams.get('id_pesq_tipo')!==ids.pesquisaId){
      throw new Error('O formulário CPI aberto não corresponde aos IDs validados.');
    }
    const assertIdentity=async()=>{
      const current=await this.readDetailFrame(ids);
      if(!current||current.frame!==frame||current.raw.cpfText.replace(/\D/g,'')!==checked.cpf){
        throw new Error('Identidade CPI mudou durante o preenchimento.');
      }
    };
    beginStep('cpi_fill');
    await this.prepareForm(frame, classification, signal);
    await assertIdentity();
    const upload = await this.singleControl(frame, CPI_FORM.upload, this.timeouts.fieldWait, signal, 'cpi_fill');
    const accept = await upload.getAttribute('accept');
    if (accept && !/(?:pdf|\.pdf)/i.test(accept)) throw new Error('O campo da CPI não permite PDF.');
    const save = await this.singleControl(frame, CPI_FORM.save, this.timeouts.fieldWait, signal, 'cpi_fill');
    if(!await save.evaluate(button=>{
      const form=button.closest('form');
      return !!form&&form===document.querySelector('#MainPage_FileUpload1')?.closest('form');
    })){
      throw new Error('Botão Alterar e anexo PDF pertencem a formulários diferentes.');
    }
    progress.endStep?.('success');
    beginStep('cpi_attach');
    throwIfAborted(signal, 'cpi_attach');
    // A partir do anexo, um POST/navegação do frame indica possível efeito remoto (handler do portal).
    watchedPage=page;
    observeAfterAttach=request=>{
      try{if(request.frame()===frame&&(request.method()==='POST'||request.isNavigationRequest()))markEffects();}
      catch{markEffects();}
    };
    page.on('request',observeAfterAttach);
    await upload.setInputFiles(pdfPath);
    const fileName=basename(pdfPath);
    const fileOk=async()=>upload.evaluate((input,expected)=>{
      const chosen=(input as HTMLInputElement).files;
      return chosen?.length===1&&chosen[0].name===expected&&chosen[0].size>100;
    },fileName).catch(()=>false);
    if(!await fileOk())throw new Error('O formulário CPI não confirmou o anexo PDF.');
    // Reaplicar e conferir depois do anexo, como no projeto validado (o anexo pode disparar handlers).
    await this.prepareForm(frame, classification, signal);
    if(!await fileOk())throw new Error('O anexo PDF foi perdido após a conferência dos campos.');
    await assertIdentity();
    progress.endStep?.('success');
    beginStep('cpi_save');
    throwIfAborted(signal, 'cpi_save');
    const state={navigated:false,failed:false,auxiliary404:false};
    let dialogSeen=false;
    const onDialog=(dialog:import('playwright-core').Dialog)=>{
      // O confirm de salvamento é tratado pelo waitForEvent abaixo; aqui só alerts posteriores.
      if(dialog.type()==='confirm'&&CPI_FORM.confirmMessage.test(dialog.message()))return;
      if(dialog.type()!=='alert'){void dialog.dismiss().catch(()=>{});return;}
      if(/(?:erro|falha|inv[aá]lid|n[aã]o foi poss[ií]vel|n[aã]o autorizado)/i.test(dialog.message()))state.failed=true;
      void dialog.accept().catch(()=>{});
    };
    const onNavigation=(changed:Frame)=>{if(changed===frame&&dialogSeen)state.navigated=true;};
    // Documento principal = navegação do frame do formulário (POST de Alterar e o que ele carregar).
    // Recursos auxiliares (outros frames, XHR, cpi_api_request.aspx) não invalidam o formulário.
    const onResponse=(response:import('playwright-core').Response)=>{
      try{
        if(!dialogSeen)return;
        const request=response.request();
        const verdict=classifyCpiHttpResponse({url:response.url(),status:response.status(),
          mainDocument:request.frame()===frame&&request.isNavigationRequest()});
        if(verdict==='auxiliary_404')state.auxiliary404=true;
        // Falha do documento principal ou falha não observada do recurso auxiliar: envio incerto, nunca mascarado.
        else if(verdict==='main_failed'||verdict==='auxiliary_failed')state.failed=true;
      }catch{/* resposta não pertinente */}
    };
    page.on('dialog',onDialog);
    page.on('framenavigated',onNavigation);
    page.on('response',onResponse);
    try{
      if(signal.aborted)return 'not_submitted';
      const dialogPromise=page.waitForEvent('dialog',{timeout:Math.min(10000,Math.max(2000,confirmationTimeoutMs)),
        predicate:dialog=>dialog.type()==='confirm'&&CPI_FORM.confirmMessage.test(dialog.message())});
      // Clique real (como no projeto validado); se a acionabilidade falhar, disparo do evento no elemento.
      const clickPromise=save.click({timeout:8000}).catch(async()=>{
        if(!dialogSeen)await save.dispatchEvent('click').catch(()=>undefined);
      });
      let dialog:import('playwright-core').Dialog;
      try{dialog=await dialogPromise;}
      catch{
        await clickPromise;
        // Sem confirmação não há submissão pelo upd_pesq; qualquer POST observado torna o resultado incerto.
        return progress.effectsPossible?'unverified':'not_submitted';
      }
      dialogSeen=true;
      if(mode==='dry_run'||signal.aborted){
        await dialog.dismiss().catch(()=>undefined);
        await clickPromise;
        if(signal.aborted)return progress.effectsPossible?'unverified':'not_submitted';
        rehearsed=true;
        return 'dry_run_ok';
      }
      markEffects();
      await dialog.accept();
      await clickPromise;
      const exit=await this.waitForFormExit(page,frame,state,confirmationTimeoutMs,signal);
      if(exit!=='left')return 'unverified';
      // Formulário aceito, ainda sem prova de persistência: `finalizeSubmittedResponse` faz a leitura independente.
      this.lastConfirmedSave = {...ids,frame,url:frameUrl.href,cpf:checked.cpf,classification,auxiliary404:state.auxiliary404};
      saved=true;
      return state.auxiliary404?'confirmed_auxiliary_404':'confirmed';
    }finally{
      page.off('dialog',onDialog);
      page.off('framenavigated',onNavigation);
      page.off('response',onResponse);
    }
    } catch {
      return progress.effectsPossible?'unverified':'not_submitted';
    } finally {
      if(watchedPage&&observeAfterAttach)watchedPage.off('request',observeAfterAttach);
      progress.endStep?.(saved||rehearsed?'success':'failed');
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
    // Nova sessão do navegador: a janela retida deixa de existir junto com o processo.
    this.operationalHold = null;
    if (browser) await this.closeBrowser(browser);
  }
}

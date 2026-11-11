import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { filterPendingPerson29, readListingCount, type CpiPendingFilterResult } from './pending-filter.ts';
import { inspectPendingPerson29Rows, validateCpiRowId, type CpiPendingRowId, type CpiPendingRowsInspection } from './pending-rows.ts';
import { validateCpiPersonDetails, resolveCpiDetailHeadings, type CpiRawPersonDetails, type CpiPendingPersonDetail } from './pending-details.ts';
import { classifyCpiVisibleServerError, hasConfirmedSavedCpiResponse, type CpiSavedResponseEvidence } from './response-confirmation.ts';
import { refreshPendingAfterConfirmedSave } from './pending-refresh.ts';

export const CPI_LOGIN_URL = 'https://adm.cpicentral.com.br/acesso/checkUser.aspx';
const CPI_HOST = 'adm.cpicentral.com.br';

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
  private lastReadCpf: {ids: CpiPendingRowId; cpf: string} | null = null;
  private lastConfirmedSave: CpiPendingRowId | null = null;

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
      await this.page?.bringToFront();
      return this.status();
    }
    // Se a aba foi fechada manualmente, liberar o processo anterior antes de abrir outro.
    if (this.browser) await this.close();
    this.opening = this.launch();
    try { return await this.opening; } finally { this.opening = null; }
  }
  private async launch(): Promise<CpiBrowserStatus> {
    const browser = await chromium.launch({ channel: 'msedge', headless: false, timeout: 25000 });
    try {
      const context = await browser.newContext({ acceptDownloads: false });
      const page = await context.newPage();
      this.browser = browser;
      this.context = context;
      this.page = page;
      browser.on('disconnected', () => { if (this.browser === browser) { this.browser = null; this.context = null; this.page = null; this.lastFilter = null; this.lastMappedRows = []; this.lastReadCpf = null; this.lastConfirmedSave = null; } });
      await page.goto(CPI_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return this.status();
    } catch (error) {
      if (this.browser === browser) { this.browser = null; this.context = null; this.page = null; }
      await browser.close().catch(() => {});
      throw error;
    }
  }
  async inspectControls(): Promise<CpiDomInspection> {
    if (this.status().state !== 'open' || !this.page) throw new Error('Abra primeiro o navegador CPI.');
    const controls: CpiControlInfo[] = [];
    let framesInspected = 0;
    let truncated = false;
    for (const frame of this.page.frames()) {
      let host = '';
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
    const result = await filterPendingPerson29(this.page);
    if (result.total !== null && result.state !== 'unconfirmed') {
      this.lastFilter = {result, pageUrl: this.page.url(), checkedAt: Date.now()};
    }
    return result;
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
    const currentTotal = await readListingCount(this.page, 4000);
    if (currentTotal !== last.result.total) {
      return {state:'unconfirmed',total:currentTotal,visibleRows:0,rows:[],framesInspected:0,
        message:'A listagem mudou após a filtragem. Atualize o filtro 29 antes de continuar.'};
    }
    const result = await inspectPendingPerson29Rows(this.page, currentTotal);
    if (result.state === 'mapped') this.lastMappedRows = result.rows;
    return result;
  }

  /** Abre somente o formulário existente de um registro mapeado; não salva nem consulta a Deskdata. */
  async inspectPendingPersonDetails(ids: CpiPendingRowId): Promise<CpiPendingPersonDetail> {
    if (this.status().state !== 'open' || !this.page) throw new Error('Abra e autentique primeiro o navegador CPI.');
    if (!validateCpiRowId(ids) || !this.lastMappedRows.some(row =>
      row.pesquisaId === ids.pesquisaId && row.solicitacaoId === ids.solicitacaoId)) {
      throw new Error('A pesquisa não foi identificada e validada na listagem atual.');
    }
    const page = this.page;
    this.lastReadCpf = null;
    // Se o usuário já abriu manualmente o mesmo formulário, aproveitá-lo sem segundo clique.
    let raw = await this.readDetailsFromOpenFrame(ids);
    if (!raw) {
      const actions: Array<import('playwright-core').Locator> = [];
      for (const frame of page.frames()) {
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
      // Clique nativo do DOM: evita falha de viewport em iframe de layout legado.
      await actions[0].evaluate(element => {
        if (element.getAttribute('title') !== 'Responder / Atualizar') throw new Error('Ação CPI inesperada.');
        (element as HTMLElement).click();
      });
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && !raw) {
        raw = await this.readDetailsFromOpenFrame(ids);
        if (!raw) await page.waitForTimeout(250);
      }
    }
    if (!raw) {
      const diagnostic = await this.detailReadDiagnostic();
      throw new Error(`O detalhe da CPI nao foi reconhecido (${diagnostic}). Nenhuma consulta ou envio foi executado.`);
    }
    const checked = validateCpiPersonDetails(ids, raw);
    // CPF completo permanece somente na memória do processo principal para uma etapa futura.
    this.lastReadCpf = {ids,cpf:checked.cpf};
    return checked.publicDetail;
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

  private async readDetailsFromOpenFrame(_ids: CpiPendingRowId): Promise<CpiRawPersonDetails | null> {
    if (!this.page) return null;
    // Shadowbox: o formulario fica em iframe#sb-content. Priorizar esse frame
    // evita selecionar por engano um formulario antigo ou oculto em outro frame.
    const shadowboxVisible = await this.page.locator('#sb-container').isVisible().catch(() => false);
    let frames: import('playwright-core').Frame[] = [];
    if (shadowboxVisible) {
      try {
        const iframe = await this.page.locator('iframe#sb-content').elementHandle({timeout:500});
        const activeFrame = await iframe?.contentFrame();
        if (activeFrame) frames = [activeFrame];
      } catch { /* Shadowbox ainda carregando; sera tentado novamente */ }
    } else {
      frames = this.page.frames();
    }
    for (const frame of frames) {
      try {
        if (new URL(frame.url()).hostname !== CPI_HOST) continue;
        const raw = await frame.evaluate(() => {
          const titles = Array.from(document.querySelectorAll('h1,h2,h3,.mt'))
            .map(node => (node as HTMLElement).innerText?.trim() ?? node.textContent?.trim() ?? '')
            .filter(Boolean).slice(0, 30);
          // A CPI usa mais de um template. Em alguns, o titulo cinza da
          // solicitacao nao e um H2. Extrair apenas os IDs associados a esses
          // rotulos, nunca enviar o texto integral do iframe ao Electron.
          const visibleText = (document.body?.innerText ?? '').normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '').toUpperCase();
          for (const match of visibleText.matchAll(/\bDADOS(?: DA)? SOLICITACAO\s*(?:[-:#]\s*)?([1-9]\d{3,11})(?!\d)/g)) {
            titles.push(`Dados Solicitação ${match[1]}`);
          }
          for (const match of visibleText.matchAll(/\bDADOS DA PESQUISA\s*(?:[-:#]\s*)?([1-9]\d{3,11})(?!\d)/g)) {
            titles.push(`Dados da Pesquisa - ${match[1]}`);
          }
          let cpfText = '', pesquisaType = '';
          for (const row of document.querySelectorAll('.row')) {
            const cells = Array.from(row.children).filter(node => node.matches('.cell,td'));
            for (let i = 0; i < cells.length - 1; i++) {
              const label = (cells[i].textContent ?? '').normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
              if (label === 'CPF:') cpfText = cells[i+1].textContent?.trim() ?? '';
              if (label === 'PESQUISA:') pesquisaType = cells[i+1].textContent?.trim() ?? '';
            }
          }
          // Fallback apenas para o CPF vinculado a rotulo. Nunca extrair CPF
          // arbitrario de outras secoes, como historico da pesquisa.
          if (!cpfText) {
            const matches = [...visibleText.matchAll(/\bCPF\s*:\s*(\d{3}\.\d{3}\.\d{3}-\d{2})\b/g)];
            if (matches.length === 1) cpfText = matches[0][1];
          }
          if (!pesquisaType && /\bPESQUISA\s*:\s*PROCESSOS JUDICIAIS CRIMINAL FORUM NACIONAL CPF\b/.test(visibleText)) {
            pesquisaType = 'PROCESSOS JUDICIAIS CRIMINAL FORUM NACIONAL CPF';
          }
          const selects = Array.from(document.querySelectorAll('select'));
          const status = selects.map(el => el.selectedOptions[0]?.textContent?.trim() ?? '')
            .find(text => /aguardando pesquisa|respondida/i.test(text)) ?? '';
          return {titles,cpfText,pesquisaType,status};
        });
        const headings = resolveCpiDetailHeadings(raw.titles);
        if (!headings) continue;
        return {...headings,cpfText:raw.cpfText,pesquisaType:raw.pesquisaType,status:raw.status};
      } catch { /* iframe pode estar em navegacao; nao usar dados parciais */ }
    }
    return null;
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
  private async savedResponseEvidence(ids: CpiPendingRowId, classification: 'restrictions' | 'information'): Promise<CpiSavedResponseEvidence | null> {
    if (!this.page) return null;
    for (const frame of this.page.frames()) {
      try {
        if (new URL(frame.url()).hostname !== CPI_HOST) continue;
        const rawEvidence = await frame.evaluate((expected): (CpiSavedResponseEvidence & {errorSignals:string}) | null => {
          const headings = Array.from(document.querySelectorAll('h2')).map(node => (node.textContent ?? '').trim());
          const matchingIds = headings.some(t => /Dados\s+Solicita/i.test(t) && t.includes(expected.ids.solicitacaoId)) &&
            headings.some(t => /Dados\s+da\s+Pesquisa/i.test(t) && t.includes(expected.ids.pesquisaId));
          if (!matchingIds) return null;
          const content = (document.body.innerText ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ').toUpperCase();
          const correct = expected.classification === 'restrictions'
            ? /RESULTADO\s*:\s*(?:[A-Z_]+\s+){0,2}SIM\s*,?\s*CONSTA RESTRICOES\b/.test(content)
            : /RESULTADO\s*:\s*(?:[A-Z_]+\s+){0,2}HA INFORMACOES\b/.test(content);
          // Transferir somente indicativos do erro, jamais o texto integral (CPF/dados da CPI).
          const errorSignals = [
            /ERRO DE SERVIDOR NO APLICATIVO/.test(content) ? 'ERRO DE SERVIDOR NO APLICATIVO' : '',
            /NAO E POSSIVEL ENCONTRAR O RECURSO/.test(content) ? 'NAO E POSSIVEL ENCONTRAR O RECURSO' : '',
            /SERVER ERROR IN/.test(content) ? 'SERVER ERROR IN' : '',
            /404;404;|HTTP\s*404|\b404\b/.test(content) ? '404;404;' : '',
            /URL SOLICITADA\s*:\s*\/?CPI_API_REQUEST\.ASPX\b/.test(content)
              ? 'URL SOLICITADA: /CPI_API_REQUEST.ASPX' : ''
          ].filter(Boolean).join(' ');
          return {
            matchingIds,
            statusRespondida: /STATUS\s*:\s*RESPONDIDA\b/.test(content),
            matchingResult: correct,
            hasResponseTimestamp: /RESPONDIDA EM\s*:\s*\d{1,2}\/\d{1,2}\/\d{4}/.test(content),
            hasPdfDocument: /EM ARQUIVO\s*:\s*(?:[A-Z_]+\s+){0,2}DOCUMENTO PDF\b/.test(content),
            editableUploadPresent: !!document.querySelector('input[type="file"]'),
            serverErrorVisible: false,
            auxiliary404Observed: false,
            errorSignals
          };
        }, {ids, classification});
        if (rawEvidence) {
          const {errorSignals, ...evidence} = rawEvidence;
          const serverErrors = classifyCpiVisibleServerError(errorSignals);
          return {...evidence,serverErrorVisible:serverErrors.blocking,auxiliary404Observed:serverErrors.auxiliary404};
        }
      } catch { /* frame durante atualização: não confirmar sem evidência */ }
    }
    return null;
  }

  /** Fecha somente o modal da pesquisa que já foi confirmada; nunca fecha em envio incerto. */
  async closeCompletedDetail(ids: CpiPendingRowId): Promise<void> {
    if (!this.page || this.status().state !== 'open' || !this.lastConfirmedSave ||
        this.lastConfirmedSave.pesquisaId !== ids.pesquisaId ||
        this.lastConfirmedSave.solicitacaoId !== ids.solicitacaoId) {
      throw new Error('Fechamento CPI bloqueado: resposta não confirmada para esta solicitação.');
    }
    const page = this.page;
    const modal = page.locator('#sb-container');
    if (await modal.isVisible().catch(() => false)) {
      const title = (await page.locator('#sb-title-inner').innerText({timeout:4000})).trim();
      if (!/Responder\s*\/\s*Atualizar Pesquisa/i.test(title)) {
        throw new Error('Modal CPI inesperado após o salvamento. Fechamento manual necessário.');
      }
      const button = page.locator('#sb-title-inner [title="Fechar"]');
      if (await button.count() !== 1 || !/Shadowbox\.close\s*\(\s*\)/i.test(await button.getAttribute('onclick') ?? '')) {
        throw new Error('Controle único de fechamento da pesquisa CPI não confirmado.');
      }
      await button.evaluate(element => (element as HTMLElement).click());
      await modal.waitFor({state:'hidden',timeout:7000});
    }
    // A CPI pode manter os dados da tabela em cache depois de fechar a Shadowbox.
    // A proxima solicitacao so e liberada apos uma leitura atualizada e estavel.
    await refreshPendingAfterConfirmedSave(page, ids);
    this.lastFilter = null;
    this.lastMappedRows = [];
    this.lastReadCpf = null;
    this.lastConfirmedSave = null;
  }

  /** Preenche o formulário observado e salva sem reabrir o registro depois. */
  async uploadAndSavePersonResponse(ids: CpiPendingRowId, pdfPath: string, classification: 'restrictions' | 'information'): Promise<'confirmed' | 'confirmed_auxiliary_404' | 'unverified'> {
    if (!this.page || this.status().state !== 'open') throw new Error('Sessão CPI indisponível.');
    const raw = await this.readDetailsFromOpenFrame(ids);
    if (!raw) throw new Error('Detalhes CPI não estão abertos. Não é seguro anexar o PDF.');
    const checked = validateCpiPersonDetails(ids, raw);
    if (checked.cpf !== this.readValidatedCpf(ids)) throw new Error('CPF CPI mudou durante o processamento.');
    const page = this.page;
    this.lastConfirmedSave = null;
    const eligible = [] as Array<import('playwright-core').Frame>;
    for (const frame of page.frames()) {
      try {
        if (new URL(frame.url()).hostname !== CPI_HOST) continue;
        const headings = await frame.locator('h2').allTextContents();
        if (headings.some(text => /Dados\s+da\s+Pesquisa/i.test(text) && text.includes(ids.pesquisaId)) &&
            headings.some(text => /Dados\s+Solicita/i.test(text) && text.includes(ids.solicitacaoId))) eligible.push(frame);
      } catch { /* frame transitório */ }
    }
    if (eligible.length !== 1) throw new Error('Formulário CPI não identificado de maneira única.');
    const frame = eligible[0];
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
    await source.selectOption({ label: 'Desk Data' }, { timeout: 10000 });
    const status = await selectFor(/^Status\s*:/i);
    await status.selectOption({ label: 'Respondida' }, { timeout: 10000 });
    // O portal exibe controles de resultado após a alteração do status.
    const resultName = classification === 'restrictions' ? 'Sim, Consta Restrições' : 'Há Informações';
    const radioDeadline = Date.now() + 12000;
    let selected = false;
    while (Date.now() < radioDeadline && !selected) {
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
    await files.setInputFiles(pdfPath);
    const attached = await files.evaluate(input => {
      const chosen = (input as HTMLInputElement).files;
      return chosen?.length === 1 && /\.pdf$/i.test(chosen[0].name) && chosen[0].size > 100;
    });
    if (!attached) throw new Error('O formulário CPI não confirmou o anexo PDF.');
    // Pré-condições conferidas; a partir daqui o envio pode ser irreversível.
    const saveCandidates = frame.locator('a.button,button,input[type="submit"]');
    const actions: Array<import('playwright-core').Locator> = [];
    for (let i = 0, n = await saveCandidates.count(); i < n; i++) {
      const candidate = saveCandidates.nth(i);
      if ((await candidate.textContent().catch(() => '') ?? '').trim() === 'Alterar' ||
          await candidate.getAttribute('value').catch(() => null) === 'Alterar') actions.push(candidate);
    }
    if (actions.length !== 1) throw new Error('Botão Alterar CPI não identificado de maneira única.');
    let approvedConfirm = false;
    let httpSubmitted = false;
    let portalAlertFailure = false;
    let portalHttpFailure = false;
    const onResponse = (response: import('playwright-core').Response) => {
      try {
        const url = new URL(response.url());
        if (url.hostname === CPI_HOST && response.request().method() === 'POST' &&
            /(upd_cad|pesq_upd|alterar)/i.test(url.pathname)) {
          if (response.status() >= 200 && response.status() < 400) httpSubmitted = true;
          else if (response.status() >= 400) portalHttpFailure = true;
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
    page.on('response', onResponse);
    page.on('dialog', onDialog);
    try {
      await actions[0].evaluate(button => (button as HTMLElement).click());
      const deadline=Date.now()+20000;
      while(Date.now()<deadline) {
        const stillOpen = await this.readDetailsFromOpenFrame(ids);
        if (portalAlertFailure || portalHttpFailure) return 'unverified';
        if (approvedConfirm && httpSubmitted) {
          const evidence = await this.savedResponseEvidence(ids, classification);
          // Sumir o formulário, isoladamente, não prova êxito: o iframe pode exibir erro HTTP.
          const modalGone = !await page.locator('#sb-container').isVisible().catch(() => false);
          if (evidence && hasConfirmedSavedCpiResponse(evidence)) {
            this.lastConfirmedSave = {...ids};
            return evidence.auxiliary404Observed ? 'confirmed_auxiliary_404' : 'confirmed';
          }
          // A CPI tambem pode fechar o formulario automaticamente após salvar.
          // Sem evidencia de POST bem sucedido e confirmacao, NAO aceitar fechamento.
          if (!stillOpen && modalGone && !evidence) {
            this.lastConfirmedSave = {...ids};
            return 'confirmed';
          }
        }
        await page.waitForTimeout(300);
      }
      return 'unverified';
    } finally {
      page.off('response', onResponse);
      page.off('dialog', onDialog);
    }
  }

  async close(): Promise<void> {
    // Aguarda a criação em curso antes de encerrar e não persiste sessão/cookies no disco.
    await this.opening?.catch(() => {});
    const browser = this.browser;
    this.browser = null; this.context = null; this.page = null;
    this.lastFilter = null; this.lastMappedRows = []; this.lastReadCpf = null; this.lastConfirmedSave = null;
    if (browser) await browser.close().catch(() => {});
  }
}

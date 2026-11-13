import type { CpiPendingRowId, NormalizedData } from '../../shared/types.ts';
import type { StepTimer } from '../step-timing.ts';
import type { CpiBrowser } from './cpi-browser.ts';
import { assertQueryRecordIdentity } from '../query-history.ts';
import { assertCpiPaidBalance } from './paid-balance.ts';
import { safeCpiCycleError, type CpiScanContext, type CpiScanResult } from './full-auto-runner.ts';
import { classifyCpiError, CPI_IMMEDIATE_STOP } from './failure-classes.ts';
import { CPI_FINAL_STAGES } from './queue-selection.ts';
import { executeCpiPersonCycle } from './full-cycle.ts';
import { account, showHistoryChange, timedCycle, type MainContext } from '../ipc/context.ts';

/**
 * Orquestração do FULL AUTO (E5): uma varredura processa no máximo um item. O `index.ts` envolve a varredura
 * na exclusiva do gate (holder do agente); aqui não há flag local de concorrência.
 */
export function createCpiScan(ctx: MainContext): (context: CpiScanContext) => Promise<CpiScanResult> {
  return context => timedCycle(ctx, 'cpi', timer => cpiScanOneTimed(ctx, timer, context),
    result => result.kind === 'idle' ? (result.found === 0 ? 'empty' : 'idle') : result.kind === 'item' ? result.outcome.state : 'item_failed');
}
/**
 * Processa no máximo um item por varredura. O navegador não altera várias pesquisas de uma vez.
 * Falha de item (não sistêmica) envia o item para revisão e devolve 'item_failed'; falha sistêmica é relançada.
 */
async function cpiScanOneTimed(ctx: MainContext, timer: StepTimer, context: CpiScanContext): Promise<CpiScanResult> {
  const who = account(ctx);
  const { cpiBrowser, cpiQueue, cpiWorkflow } = ctx;
  const settings = await ctx.getSettings();
  if (!settings.outputFolder) throw new Error('Configure uma pasta de PDFs antes da automação CPI.');
  let filtered: Awaited<ReturnType<CpiBrowser['filterPendingPerson29']>>;
  // A causa original é preservada para a classificação (sessão, layout, tempo limite); a mensagem exibida é sanitizada.
  try { filtered = await timer.step('cpi_filter', () => cpiBrowser.filterPendingPerson29()); }
  catch (error) { throw new Error('Etapa filtro CPI 29: falha ao atualizar a listagem.', { cause: error }); }
  if (filtered.state === 'unconfirmed' || filtered.total === null) throw new Error('Etapa filtro CPI 29: total nao confirmado no portal.');
  if (filtered.total === 0) return { kind: 'idle', found: 0 };
  let listed: Awaited<ReturnType<CpiBrowser['inspectPendingRows']>>;
  try { listed = await timer.step('cpi_rows', () => cpiBrowser.inspectPendingRows()); }
  catch (error) { throw new Error('Etapa leitura CPI: nao foi possivel inspecionar as linhas apos o filtro.', { cause: error }); }
  if (listed.state !== 'mapped' || !listed.rows.length) throw new Error('Etapa leitura CPI: identificadores da listagem nao confirmados.');
  const rows = listed.rows, found = filtered.total;
  // Uma leitura da fila para todas as linhas; itens finais ou em revisão nunca são reabertos.
  const selection = await timer.step('cpi_select', async () => cpiQueue.select(rows, await cpiWorkflow.stages(who, rows)));
  if (!selection.ids) {
    const more = found > rows.length ? ' Há outras páginas na CPI que só aparecem quando a página atual for atendida.' : '';
    return { kind: 'idle', found, message: `Nenhuma pesquisa elegível na página: ${selection.finalCount} em revisão ou concluída(s), ${selection.deferredCount} aguardando a Deskdata.${more}` };
  }
  if (context.signal.aborted) return { kind: 'idle', found, message: 'Pausa solicitada antes de abrir a próxima pesquisa.' };
  const target = selection.ids;
  context.onItem(target);
  let result: Awaited<ReturnType<typeof executeCpiPersonCycle>>;
  try {
    result = await cpiProcessItem(ctx, timer, who, target, settings.outputFolder);
  } catch (error) {
    const failure = classifyCpiError(error);
    if (CPI_IMMEDIATE_STOP.has(failure) || ctx.session.account !== who) throw error;
    // Falha de item: revisão manual, sem nova tentativa automática deste item; o agente segue para o próximo.
    await sendCpiItemToReview(ctx, who, target);
    cpiQueue.release(target);
    return { kind: 'item_failed', found, ids: target, failure, message: safeCpiCycleError(error) };
  }
  if (result.state === 'pending') cpiQueue.defer(target); else cpiQueue.release(target);
  if (ctx.session.account !== who) throw new Error('Conta Deskdata alterada durante o processamento CPI.');
  return { kind: 'item', found, outcome: result };
}
/** Marca o item como revisão manual quando ainda não está em estágio final (submit_started permanece como está). */
async function sendCpiItemToReview(ctx: MainContext, who: string, ids: CpiPendingRowId): Promise<void> {
  const job = await ctx.cpiWorkflow.claim(who, ids);
  if (!CPI_FINAL_STAGES.has(job.stage)) await ctx.cpiWorkflow.mark(who, ids, 'review_required');
}
/** Um item CPI; o CPF é revalidado no processo principal e o renderer nunca recebe seus dígitos. */
function cpiProcessItem(ctx: MainContext, timer: StepTimer, who: string, target: CpiPendingRowId, outputFolder: string) {
  const { cpiBrowser, cpiWorkflow, history, client, approvals } = ctx;
  return executeCpiPersonCycle({
    account: who, ids: target, outputFolder, timer,
    getCpf: async () => { await cpiBrowser.inspectPendingPersonDetails(target, timer); return cpiBrowser.readValidatedCpf(target); },
    getJob: () => cpiWorkflow.get(who, target),
    claim: () => cpiWorkflow.claim(who, target),
    mark: (stage, updates) => cpiWorkflow.mark(who, target, stage, updates),
    findLatest: cpf => history.findLatest(who, cpf, 'person'),
    beginHistory: cpf => history.begin(who, cpf, 'person'),
    setQueryCode: (recordId, code) => history.setCode(recordId, code),
    getCredits: () => client.credits(),
    verifyPaidBalance: async credits => { assertCpiPaidBalance(credits, await approvals.isApproved(who)); },
    paidApproved: () => approvals.isApproved(who),
    submitCpf: (cpf, onCode) => client.submitCpf(cpf, onCode),
    checkByCode: code => client.checkByCode(code),
    savePdf: (cpf, recordId, code, data) => saveCpiPdf(ctx, who, target, outputFolder, cpf, recordId, code, data),
    uploadAndSave: async (pdf, result, mode = 'save') => {
      if (ctx.session.account !== who) throw new Error('Conta Deskdata alterada durante o processamento CPI.');
      return cpiBrowser.uploadAndSavePersonResponse(target, pdf, result, undefined, timer, mode);
    },
    closeCompletedDetail: () => cpiBrowser.closeCompletedDetail(target),
    dryRun: ctx.cpiRehearsal,
    closeWithoutSaving: () => cpiBrowser.closeDetailWithoutSaving(target)
  });
}
/** Gera o PDF CPI_<pesquisaId>_<solicitacaoId>_<data>.pdf e o registra na consulta, conferindo conta, CPF e código. */
export async function saveCpiPdf(ctx: MainContext, who: string, ids: CpiPendingRowId, folder: string, cpf: string, recordId: string, code: string | undefined, data: NormalizedData): Promise<void> {
  const identity = { account: who, kind: 'person' as const, document: cpf, queryCode: code };
  const record = await ctx.history.findById(who, recordId);
  if (!record) throw new Error('Registro CPI indisponível no histórico desta conta.');
  assertQueryRecordIdentity(record, identity);
  const outcome = await ctx.pdf.saveCpiReportPdf(folder, { cpf, consultedAt: new Date().toISOString(), queryCode: code, data }, ids);
  await ctx.history.addPdf(recordId, outcome.path, identity);
  showHistoryChange(ctx, { kind: 'person', recordId, state: 'ready' });
}

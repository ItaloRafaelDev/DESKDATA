import { isValidCpf, cpfDigits } from '../../shared/cpf.ts';
import { assertRecoveredCpf } from '../../shared/query-identity.ts';
import type { PisQueryExecution } from '../../shared/types.ts';
import type { StepTimer } from '../step-timing.ts';
import { resolvePisOutcome } from '../pis-outcome.ts';
import type { Bind } from './bind.ts';
import { account, assertPaidQueryApproved, timedCycle, validateStoredPdf, type MainContext } from './context.ts';

/** Consulta PIS: reaproveita PDF, resposta em memória ou consulta completa anterior antes de qualquer POST. */
export function registerPisIpc(bind: Bind, ctx: MainContext): void {
  bind('queryPisAndSave', rawCpf => timedCycle(ctx, 'pis', timer => queryPisAndSaveTimed(ctx, rawCpf, timer), result => result.state));
  bind('pisHistory', async () => (await ctx.history.list(account(ctx), 'pis')).map(({ account: _account, ...record }) => record));
  bind('regeneratePis', async recordId => {
    const row = await ctx.history.findById(account(ctx), recordId);
    if (!row || row.kind !== 'pis') throw new Error('Consulta PIS não encontrada.');
    if (!row.queryCode) throw new Error('Consulta sem código de recuperação disponível.');
    const received = await ctx.client.fetchByCode(row.queryCode);
    assertRecoveredCpf(received.payload, row.cpf);
    return reusedPis(await exportPis(ctx, row.cpf, received.payload, row.id, row.queryCode));
  });
}

async function exportPis(ctx: MainContext, cpf: string, payload: unknown, recordId: string, queryCode?: string): Promise<PisQueryExecution> {
  return resolvePisOutcome({
    cpf, payload, recordId, queryCode,
    markUnavailable: () => ctx.history.markPisUnavailable(recordId),
    save: async (record) => {
      const folder = (await ctx.getSettings()).outputFolder;
      if (!folder) throw new Error('Configure a pasta de destino antes de consultar.');
      const outcome = await ctx.pdf.savePisReportPdf(folder, record, queryCode);
      await ctx.history.addPdf(recordId, outcome.path);
      ctx.session.lastPisResponse = { cpf, payload, queryCode }; // somente memória, sem persistir JSON pessoal
      return outcome;
    }
  });
}
function reusedPis(result: PisQueryExecution): PisQueryExecution {
  return result.state === 'ready'
    ? { state: 'ready', pdf: { ...result.pdf, reused: true } }
    : { ...result, reused: true };
}
async function queryPisAndSaveTimed(ctx: MainContext, rawCpf: string, timer: StepTimer): Promise<PisQueryExecution> {
  const { history, client } = ctx;
  if (ctx.cpiAuto.isActive()) throw new Error('Pause o ciclo CPI FULL AUTO antes de consultar manualmente.');
  if (typeof rawCpf !== 'string' || !isValidCpf(rawCpf)) throw new Error('CPF inválido.');
  const cpf = cpfDigits(rawCpf);
  const settings = await ctx.getSettings();
  if (!settings.outputFolder) throw new Error('Selecione a pasta de destino antes de consultar.');
  const who = account(ctx);
  const previous = await history.findLatest(who, cpf, 'pis');
  if (previous) {
    for (const path of [...previous.pdfPaths].reverse()) if (await validateStoredPdf(path)) {
      return { state: 'ready', pdf: { path, queryCode: previous.queryCode, savedAt: previous.updatedAt, recordId: previous.id, reused: true } };
    }
    // Resultado terminal: não repetir POST nem GET em cada clique. GET manual continua disponível.
    if (previous.status === 'pis_unavailable') return { state: 'no_pis', recordId: previous.id, queryCode: previous.queryCode, reused: true };
    const cachedPis = ctx.session.lastPisResponse;
    if (cachedPis?.cpf === cpf) return reusedPis(await timer.step('report_pdf', () => exportPis(ctx, cpf, cachedPis.payload, previous.id, cachedPis.queryCode)));
    const previousCode = previous.queryCode;
    if (!previousCode) throw new Error('Consulta PIS anterior sem PDF nem código recuperável. Não repetiremos o POST para evitar nova cobrança.');
    const recovered = await timer.step('deskdata_fetch', () => client.fetchByCode(previousCode));
    assertRecoveredCpf(recovered.payload, cpf);
    return reusedPis(await timer.step('report_pdf', () => exportPis(ctx, cpf, recovered.payload, previous.id, recovered.queryCode)));
  }
  // Consulta completa anterior já contém basic: utilizar GET pelo código, sem criar novo POST.
  const person = await history.findLatest(who, cpf, 'person');
  const personCode = person?.queryCode;
  if (personCode) {
    const recovered = await timer.step('deskdata_fetch', () => client.fetchByCode(personCode));
    assertRecoveredCpf(recovered.payload, cpf);
    const record = await history.begin(who, cpf, 'pis');
    await history.setCode(record.id, personCode);
    return reusedPis(await timer.step('report_pdf', () => exportPis(ctx, cpf, recovered.payload, record.id, personCode)));
  }
  await assertPaidQueryApproved(ctx);
  if (await timer.step('deskdata_credits', () => client.credits()) <= 0) throw new Error('Saldo de créditos insuficiente.');
  const record = await history.begin(who, cpf, 'pis');
  const result = await timer.step('deskdata_query', () => client.queryBasicCpf(cpf, code => history.setCode(record.id, code)));
  return timer.step('report_pdf', () => exportPis(ctx, cpf, result.payload, record.id, result.queryCode));
}

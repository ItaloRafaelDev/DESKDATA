import { extname } from 'node:path';
import { stat } from 'node:fs/promises';
import { isValidCpf, cpfDigits } from '../../shared/cpf.ts';
import type { QueryExecution } from '../../shared/types.ts';
import type { StepTimer } from '../step-timing.ts';
import type { ReceivedPersonQuery } from '../person-reports.ts';
import type { Bind } from './bind.ts';
import { account, assertPaidQueryApproved, timedCycle, validateStoredPdf, type MainContext } from './context.ts';
import { pending, processReceived, ready, resolveRecorded } from './recovery.ts';

/** Consulta de pessoa (CPF), histórico e relatório da sessão. Registro cifrado sempre antes do POST. */
export function registerPersonIpc(bind: Bind, ctx: MainContext): void {
  const { history, personReports, session } = ctx;
  bind('queryAndSave', rawCpf => timedCycle(ctx, 'person', timer => queryAndSaveTimed(ctx, rawCpf, timer), result => result.state));
  bind('resumeQuery', recordId => resumePending(ctx, recordId));
  bind('history', async () => (await history.list(account(ctx), 'person')).map(({ account: _account, ...record }) => record));
  bind('recoverByCode', (rawCpf, code) => recoverByCode(ctx, rawCpf, code));
  bind('regenerateHistory', async recordId => {
    const who = account(ctx);
    const record = await history.findById(who, recordId);
    if (!record || record.kind === 'pis' || record.kind === 'company') throw new Error('Consulta não encontrada no histórico de pessoas desta conta.');
    if (!record.queryCode) throw new Error('Esta consulta não possui código recuperável. Não será criado um novo POST.');
    if (!(await ctx.getSettings()).outputFolder) throw new Error('Configure a pasta para salvar o novo PDF.');
    return resolveRecorded(ctx, record);
  });
  bind('openHistoryPdf', async (recordId, pdfPath) => {
    if (typeof recordId !== 'string' || typeof pdfPath !== 'string') throw new Error('Seleção inválida.');
    const record = await history.findById(account(ctx), recordId);
    if (!record || !record.pdfPaths.includes(pdfPath) || !(await validateStoredPdf(pdfPath))) throw new Error('PDF não encontrado ou não pertence a este histórico.');
    const result = await ctx.openPath(pdfPath);
    if (result) throw new Error('O leitor padrão do Windows não conseguiu abrir este PDF.');
  });
  bind('saveAgain', async () => {
    const result = await personReports.saveAgain();
    session.lastSavedPdf = result.path;
    return result;
  });
  bind('reprocessLast', async () => {
    const result = await personReports.reprocessLastResponse();
    session.lastSavedPdf = result.path;
    return result;
  });
  bind('recoveryStatus', async () => personReports.status());
  bind('openLastPdf', async () => {
    if (!session.lastSavedPdf || extname(session.lastSavedPdf).toLowerCase() !== '.pdf') throw new Error('Não há PDF gerado nesta sessão.');
    const pdfFile = session.lastSavedPdf;
    const info = await stat(pdfFile).catch(() => { throw new Error('PDF não localizado no destino configurado.'); });
    if (!info.isFile()) throw new Error('Arquivo PDF inválido.');
    const result = await ctx.openPath(pdfFile);
    if (result) throw new Error('O Windows não conseguiu abrir o PDF. Verifique o aplicativo leitor padrão.');
  });
  bind('openFolder', async () => {
    const folder = (await ctx.getSettings()).outputFolder;
    if (!folder) throw new Error('Nenhuma pasta configurada.');
    const result = await ctx.openPath(folder);
    if (result) throw new Error('Não foi possível abrir a pasta configurada.');
  });
}

async function resumePending(ctx: MainContext, recordId: string): Promise<QueryExecution> {
  const who = account(ctx);
  const record = await ctx.history.findById(who, recordId);
  if (!record || (record.kind !== 'person' && record.kind !== undefined && record.kind !== 'company')) throw new Error('Registro de pessoa ou empresa não encontrado.');
  if (!record.queryCode) throw new Error('Esta consulta não possui código recuperável.');
  if (record.status === 'ready' && record.pdfPaths.length) {
    for (const path of [...record.pdfPaths].reverse()) if (await validateStoredPdf(path)) return ready({ path, savedAt: record.updatedAt, recordId: record.id, queryCode: record.queryCode, reused: true });
  }
  return pending(ctx, record, true);
}
async function queryAndSaveTimed(ctx: MainContext, rawCpf: string, timer: StepTimer): Promise<QueryExecution> {
  const { history, client, personReports } = ctx;
  if (ctx.cpiAuto.isActive()) throw new Error('Pause o ciclo CPI FULL AUTO antes de consultar manualmente.');
  if (typeof rawCpf !== 'string' || !isValidCpf(rawCpf)) throw new Error('CPF inválido.');
  const cpf = cpfDigits(rawCpf);
  const settings = await ctx.getSettings();
  if (!settings.outputFolder) throw new Error('Configure a pasta de destino antes de consultar.');
  const who = account(ctx);
  const previous = await history.findLatest(who, cpf);
  if (previous) {
    const validPaths = [];
    for (const file of [...previous.pdfPaths].reverse()) if (await validateStoredPdf(file)) validPaths.push(file);
    if (validPaths.length) {
      personReports.clearReport(); ctx.session.lastSavedPdf = validPaths[0];
      return ready({ path: validPaths[0], savedAt: previous.updatedAt, queryCode: previous.queryCode, recordId: previous.id, reused: true });
    }
    if (!previous.queryCode) {
      const cached = personReports.readFor(who, cpf, previous.id);
      if (cached) return ready(await timer.step('report_pdf', () => processReceived(ctx, cached)));
      throw new Error('Existe uma consulta anterior deste CPF sem PDF disponível nem código recuperável. Nenhum novo POST foi enviado. Verifique o histórico antes de autorizar outra consulta.');
    }
    return resolveRecorded(ctx, previous, timer);
  }
  await assertPaidQueryApproved(ctx);
  const credits = await timer.step('deskdata_credits', () => client.credits());
  if (credits <= 0) throw new Error('Saldo de créditos indisponível ou zerado.');
  // Registro cifrado ANTES do POST. Se a conexão cair, não repetimos uma operação potencialmente cobrada.
  const record = await history.begin(who, cpf);
  const outcome = await timer.step('deskdata_query', () => client.submitCpf(cpf, code => history.setCode(record.id, code)));
  if (outcome.state === 'pending') return pending(ctx, { ...record, queryCode: outcome.queryCode });
  const received: ReceivedPersonQuery = { account: who, recordId: record.id, cpf, consultedAt: new Date().toISOString(), queryCode: outcome.queryCode, payload: outcome.payload };
  return ready(await timer.step('report_pdf', () => processReceived(ctx, received)));
}
async function recoverByCode(ctx: MainContext, rawCpf: string, code: string): Promise<QueryExecution> {
  if (!isValidCpf(rawCpf) || !/^Q-[A-F0-9]{10}$/.test(code)) throw new Error('Informe CPF válido e código no formato Q-XXXXXXXXXX.');
  const cpf = cpfDigits(rawCpf); const who = account(ctx);
  if (!(await ctx.getSettings()).outputFolder) throw new Error('Configure a pasta de destino antes de recuperar.');
  let record = await ctx.history.findLatest(who, cpf);
  if (record?.queryCode && record.queryCode !== code) throw new Error('Este CPF já está associado a outro código. Nenhuma requisição foi enviada.');
  if (!record) record = await ctx.history.begin(who, cpf);
  await ctx.history.setCode(record.id, code);
  return resolveRecorded(ctx, { ...record, queryCode: code });
}

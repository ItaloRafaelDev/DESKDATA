import { assertRecoveredCnpj } from '../../shared/company-identity.ts';
import { normalizeCompanyResponse } from '../../shared/company-report.ts';
import { assertRecoveredCpf } from '../../shared/query-identity.ts';
import type { QueryExecution, QueryOutcome } from '../../shared/types.ts';
import { IPC_INVOKE } from '../../shared/ipc-contract.ts';
import { NULL_TIMER, type StepTimer } from '../step-timing.ts';
import type { ReceivedPersonQuery } from '../person-reports.ts';
import type { QueryRecord } from '../query-history.ts';
import type { PendingTarget } from '../pending-queries.ts';
import { showHistoryChange, type MainContext } from './context.ts';

/** Recuperação de consultas por código, compartilhada por pessoa, empresa, login e limpeza. Nunca envia POST. */

/** `remember=false` em recuperações de segundo plano: não trocam o "último PDF" que o usuário está vendo (C7). */
export async function processReceived(ctx: MainContext, received: ReceivedPersonQuery, remember = true): Promise<QueryOutcome> {
  const result = await ctx.personReports.processReceived(received);
  if (remember) ctx.session.lastSavedPdf = result.path;
  return result;
}
export function ready(pdf: QueryOutcome): QueryExecution { return { state: 'ready', pdf }; }
export function targetFrom(record: QueryRecord): PendingTarget {
  if (!record.queryCode) throw new Error('Consulta sem código recuperável.');
  if (record.kind === 'company') return { id: record.id, kind: 'company', account: record.account, cnpj: record.cnpj, queryCode: record.queryCode };
  return { id: record.id, kind: 'person', account: record.account, cpf: record.cpf, queryCode: record.queryCode };
}
export async function pending(ctx: MainContext, record: QueryRecord, immediate = false): Promise<QueryExecution> {
  if (!record.queryCode) throw new Error('Consulta sem código para recuperação automática.');
  if (!ctx.monitor.isWatching(record.id)) {
    await ctx.history.setPending(record.id);
    if (!ctx.gate.isShuttingDown()) ctx.monitor.watch(targetFrom(record), immediate);
  }
  return { state: 'pending', recordId: record.id, queryCode: record.queryCode };
}
export async function exportCompany(ctx: MainContext, cnpj: string, payload: unknown, recordId: string, queryCode?: string): Promise<QueryOutcome> {
  const record = normalizeCompanyResponse(payload);
  assertRecoveredCnpj(payload, cnpj);
  const folder = (await ctx.getSettings()).outputFolder;
  if (!folder) throw new Error('Configure a pasta de destino antes de consultar.');
  ctx.session.lastCompanyResponse = { cnpj, payload, queryCode };
  const saved = await ctx.pdf.saveCompanyReportPdf(folder, record, cnpj, new Date().toISOString(), queryCode);
  await ctx.history.addPdf(recordId, saved.path);
  return { ...saved, recordId };
}
export async function resolveRecorded(ctx: MainContext, record: QueryRecord, timer: StepTimer = NULL_TIMER): Promise<QueryExecution> {
  const code = record.queryCode;
  if (!code) throw new Error('Código recuperável indisponível.');
  if (ctx.monitor.isWatching(record.id)) return { state: 'pending', recordId: record.id, queryCode: code };
  const received = await timer.step('deskdata_fetch', () => ctx.client.checkByCode(code));
  if (received.state === 'pending') return pending(ctx, record);
  const cnpj = record.cnpj;
  if (record.kind === 'company' && cnpj) {
    assertRecoveredCnpj(received.payload, cnpj);
    return ready({ ...await timer.step('report_pdf', () => exportCompany(ctx, cnpj, received.payload, record.id, code)), reused: true });
  }
  assertRecoveredCpf(received.payload, record.cpf);
  const result: ReceivedPersonQuery = { account: record.account, recordId: record.id, cpf: record.cpf, consultedAt: new Date().toISOString(), queryCode: code, payload: received.payload };
  return ready({ ...await timer.step('report_pdf', () => processReceived(ctx, result)), reused: true });
}
/** Recuperação em segundo plano; o gate a rastreia (`background`) para drenagem na limpeza, troca de sessão e encerramento. */
export async function completePending(ctx: MainContext, target: PendingTarget, payload: unknown): Promise<void> {
  if (ctx.gate.heldBy(IPC_INVOKE.cleanLocalData)) return;
  if (ctx.session.account !== target.account) throw new Error('Sessão encerrada durante recuperação.');
  const current = await ctx.history.findById(target.account, target.id);
  if (!current || current.status === 'ready') return;
  if (target.kind === 'company') {
    if (!target.cnpj) throw new Error('CNPJ ausente do histórico de consulta.');
    assertRecoveredCnpj(payload, target.cnpj);
    await exportCompany(ctx, target.cnpj, payload, target.id, target.queryCode);
  } else {
    if (!target.cpf) throw new Error('CPF ausente do histórico de consulta.');
    assertRecoveredCpf(payload, target.cpf);
    const received: ReceivedPersonQuery = { account: target.account, recordId: target.id, cpf: target.cpf, consultedAt: new Date().toISOString(), queryCode: target.queryCode, payload };
    await processReceived(ctx, received, false);
  }
  showHistoryChange(ctx, { kind: target.kind, recordId: target.id, state: 'ready' });
}
export async function resumeAfterAuthentication(ctx: MainContext, who: string): Promise<void> {
  for (const kind of ['person', 'company'] as const) {
    for (const row of await ctx.history.list(who, kind)) {
      if (!ctx.gate.isShuttingDown() && row.status === 'pending' && row.queryCode) ctx.monitor.watch(targetFrom(row), true);
    }
  }
}

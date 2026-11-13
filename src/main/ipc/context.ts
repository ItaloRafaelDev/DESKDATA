import { extname } from 'node:path';
import { stat } from 'node:fs/promises';
import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import type { AppSettings, QueryOutcome, QueryUpdate, ReportPayload } from '../../shared/types.ts';
import { IPC_EVENTS, IPC_INVOKE } from '../../shared/ipc-contract.ts';
import { createStepTimer, type StepTimer, type TimedFlow, type TimedOutcome } from '../step-timing.ts';
import type { OperationGate } from '../operation-gate.ts';
import type { DeskdataClient } from '../deskdata-client.ts';
import type { CpiBrowser } from '../cpi/cpi-browser.ts';
import type { CpiPendingMonitor } from '../cpi/pending-monitor.ts';
import type { CpiFullAutoRunner } from '../cpi/full-auto-runner.ts';
import type { CpiQueueSelector } from '../cpi/queue-selection.ts';
import type { CpiWorkflowStore } from '../cpi/workflow-store.ts';
import type { DialogGuard } from '../dialog-guard.ts';
import type { QueryHistoryStore } from '../query-history.ts';
import type { PersonReportService } from '../person-reports.ts';
import type { PendingQueryMonitor } from '../pending-queries.ts';
import type { MaintenanceService } from '../maintenance.ts';
import type { BackupService } from '../backup.ts';
import type { AccountApprovalStore } from '../account-approval.ts';
import type { CredentialStore } from '../credentials.ts';
import type { DiagnosticLogger } from '../diagnostics.ts';
import type { CpiPendingRowId } from '../../shared/types.ts';
import type { CompanyRecord } from '../../shared/company-report.ts';
import type { PisRecord } from '../../shared/pis-report.ts';

/** Estado da sessão em memória (antes variáveis `let` do index.ts). Nada aqui é persistido. */
export interface SessionState {
  account: string | null;
  lastSavedPdf: string | null;
  lastCompanyResponse: { cnpj: string; payload: unknown; queryCode?: string } | null;
  lastPisResponse: { cpf: string; payload: unknown; queryCode?: string } | null;
}

/**
 * Dependências injetadas pelo index.ts (raiz de composição, E5). Os módulos de `ipc/` nunca importam
 * `electron` nem serviços com efeito em tempo de execução: tudo chega por aqui (também permite os testes do
 * processo principal substituírem essas fronteiras).
 */
export interface MainContext {
  session: SessionState;
  gate: OperationGate;
  client: DeskdataClient;
  cpiBrowser: CpiBrowser;
  cpiMonitor: CpiPendingMonitor;
  cpiAuto: CpiFullAutoRunner;
  cpiQueue: CpiQueueSelector;
  cpiWorkflow: CpiWorkflowStore;
  dialogs: DialogGuard;
  history: QueryHistoryStore;
  personReports: PersonReportService;
  monitor: PendingQueryMonitor;
  maintenance: MaintenanceService;
  backups: BackupService;
  approvals: AccountApprovalStore;
  credentials: CredentialStore;
  diagnostics: DiagnosticLogger;
  dataDir: string;
  getSettings: () => Promise<AppSettings>;
  pickOutputFolder: () => Promise<string | null>;
  saveOutputFolder: (folder: string) => Promise<AppSettings>;
  pdf: {
    saveCpiReportPdf: (folder: string, report: ReportPayload, ids: CpiPendingRowId) => Promise<QueryOutcome>;
    savePisReportPdf: (folder: string, record: PisRecord, queryCode?: string) => Promise<QueryOutcome>;
    saveCompanyReportPdf: (folder: string, record: CompanyRecord, cnpj: string, consultedAt: string, queryCode?: string) => Promise<QueryOutcome>;
  };
  showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
  openPath: (path: string) => Promise<string>;
  getMainWindow: () => BrowserWindow | undefined;
}

export function toError(e: unknown): Error { return e instanceof Error ? e : new Error('Ocorreu um erro não identificado.'); }
/** Troca de sessão em andamento = exclusiva do gate com login ou logout. */
export function sessionChanging(ctx: MainContext): boolean { return ctx.gate.heldBy(IPC_INVOKE.authenticate, IPC_INVOKE.logout); }
export function account(ctx: MainContext): string {
  if (sessionChanging(ctx)) throw new Error('Troca de sessão em andamento.');
  if (!ctx.session.account) throw new Error('Autentique-se antes de consultar o histórico.');
  return ctx.session.account;
}
export async function viewSettings(ctx: MainContext): Promise<AppSettings> {
  const settings = await ctx.getSettings();
  const who = ctx.session.account;
  return { ...settings, paidQueriesApproved: who && !sessionChanging(ctx) ? await ctx.approvals.isApproved(who) : false };
}
export async function assertPaidQueryApproved(ctx: MainContext): Promise<void> {
  if (!await ctx.approvals.isApproved(account(ctx))) throw new Error('Autorize novas consultas para esta conta em Minha conta.');
}
export async function validateStoredPdf(path: string): Promise<boolean> {
  if (extname(path).toLowerCase() !== '.pdf') return false;
  try { return (await stat(path)).isFile(); } catch { return false; }
}
export function sendToRenderer(ctx: MainContext, channel: string, payload: unknown): void {
  const window = ctx.getMainWindow();
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, payload);
}
export function showHistoryChange(ctx: MainContext, update: QueryUpdate): void {
  void ctx.diagnostics?.write('query_update', { state: update.state }).catch(() => {});
  sendToRenderer(ctx, IPC_EVENTS.queryUpdates, update);
}
/** Medição por ciclo, gravada no diagnóstico com id de correlação e somente nomes fixos de etapa. */
export function cycleTimer(ctx: MainContext, flow: TimedFlow): StepTimer {
  return createStepTimer(flow, (event, fields) => ctx.diagnostics?.write(event, fields));
}
/** Encerra a medição com o resultado do ciclo; um erro relançado preserva o comportamento original. */
export async function timedCycle<T>(ctx: MainContext, flow: TimedFlow, work: (timer: StepTimer) => Promise<T>, outcome: (result: T) => TimedOutcome | undefined): Promise<T> {
  const timer = cycleTimer(ctx, flow);
  try { const result = await work(timer); timer.finish('success', outcome(result)); return result; }
  catch (error) { timer.finish('failed', undefined, error); throw error; }
}

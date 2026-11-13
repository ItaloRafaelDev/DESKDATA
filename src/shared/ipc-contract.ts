import type { DesktopApi } from './types.ts';

/**
 * Contrato único de canais IPC (E5). Preload e processo principal usam só estas constantes:
 * nenhum nome de canal aparece como string literal fora deste arquivo.
 */
type SubscribeMethod = Extract<keyof DesktopApi, `subscribe${string}`>;
export type InvokeMethod = Exclude<keyof DesktopApi, SubscribeMethod>;
export type ArgsOf<M extends InvokeMethod> = Parameters<DesktopApi[M]>;
export type ResultOf<M extends InvokeMethod> = Awaited<ReturnType<DesktopApi[M]>>;

export const IPC_INVOKE = {
  cpiAutoStatus: 'cpi:auto:status',
  cpiAutoStart: 'cpi:auto:start',
  cpiAutoPause: 'cpi:auto:pause',
  cpiHistory: 'cpi:history:list',
  cpiPendingWorkflows: 'cpi:workflow:pending',
  cpiVerifyWorkflow: 'cpi:workflow:verify',
  cpiOpenHistoryPdf: 'cpi:history:open-pdf',
  cpiOpen: 'cpi:open',
  cpiStatus: 'cpi:status',
  cpiInspect: 'cpi:inspect',
  cpiFilterPerson29: 'cpi:filter-person-29',
  cpiInspectPendingRows: 'cpi:rows:inspect',
  cpiInspectPendingPersonDetails: 'cpi:details:inspect',
  cpiInspectPersonHistory: 'cpi:person:history',
  cpiPreparePersonPdf: 'cpi:person:prepare',
  cpiClose: 'cpi:close',
  cpiMonitorStart: 'cpi:monitor:start',
  cpiMonitorPause: 'cpi:monitor:pause',
  cpiMonitorStatus: 'cpi:monitor:status',
  getSettings: 'settings:get',
  maintenancePreview: 'maintenance:preview',
  createBackup: 'backup:create',
  openBackupFolder: 'backup:open-folder',
  openDiagnosticsFolder: 'diagnostics:open-folder',
  cleanLocalData: 'maintenance:clean',
  chooseFolder: 'settings:choose-folder',
  setPaidQueriesApproved: 'settings:approve',
  authenticate: 'auth:login',
  credentialsStatus: 'credentials:status',
  loadSavedCredentials: 'credentials:load',
  forgetSavedCredentials: 'credentials:forget',
  logout: 'auth:logout',
  credits: 'api:credits',
  queryAndSave: 'api:query',
  queryPisAndSave: 'pis:query',
  queryCompanyAndSave: 'company:query',
  companyHistory: 'company:history',
  resumeQuery: 'queries:resume',
  regenerateCompany: 'company:regenerate',
  pisHistory: 'pis:history',
  regeneratePis: 'pis:regenerate',
  saveAgain: 'report:save-again',
  reprocessLast: 'report:reprocess',
  recoveryStatus: 'report:recovery-status',
  openFolder: 'report:open-folder',
  openLastPdf: 'report:open-pdf',
  history: 'history:list',
  openHistoryPdf: 'history:open-pdf',
  recoverByCode: 'history:recover-code',
  regenerateHistory: 'history:regenerate'
} as const satisfies Record<InvokeMethod, string>;
export type InvokeChannel = typeof IPC_INVOKE[InvokeMethod];

/** Eventos main → renderer. */
export const IPC_EVENTS = {
  queryUpdates: 'queries:updated',
  cpiAuto: 'cpi:auto:updated',
  cpiMonitor: 'cpi:monitor:updated'
} as const;

/** Alteram estado compartilhado: uma por vez no OperationGate (antes `exclusiveChannels`). */
export const EXCLUSIVE_INVOKE: ReadonlySet<InvokeMethod> = new Set<InvokeMethod>([
  'queryAndSave', 'queryPisAndSave', 'queryCompanyAndSave', 'resumeQuery', 'recoverByCode',
  'regenerateHistory', 'regeneratePis', 'regenerateCompany', 'reprocessLast', 'saveAgain',
  'cleanLocalData', 'createBackup', 'authenticate', 'logout',
  'cpiOpen', 'cpiInspect', 'cpiFilterPerson29', 'cpiInspectPendingRows', 'cpiInspectPendingPersonDetails',
  'cpiInspectPersonHistory', 'cpiPreparePersonPdf', 'cpiVerifyWorkflow', 'cpiClose'
]);

/** Pausam o FULL AUTO e o monitor antes de reservar a exclusiva. */
export const CPI_STOPPING_INVOKE: ReadonlySet<InvokeMethod> = new Set<InvokeMethod>(['cpiClose', 'logout']);

/** Inspeção manual da CPI: registrada só fora do aplicativo instalado (`!app.isPackaged`). */
export const DEV_ONLY_INVOKE: ReadonlySet<InvokeMethod> = new Set<InvokeMethod>([
  'cpiInspect', 'cpiFilterPerson29', 'cpiInspectPendingRows', 'cpiInspectPendingPersonDetails',
  'cpiInspectPersonHistory', 'cpiPreparePersonPdf'
]);

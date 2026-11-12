export const DATASETS = ['basic', 'phones', 'addresses', 'emails', 'lawsuits'] as const;
export type DatasetName = (typeof DATASETS)[number];
export type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };
export type DatasetStatus = 'ok' | 'empty';
export interface DatasetResult {
  status: DatasetStatus;
  value: unknown;
}
export type NormalizedData = Record<DatasetName, DatasetResult>;
export interface ReportPayload {
  demonstration?: boolean;
  cpf: string;
  consultedAt: string;
  queryCode?: string;
  data: NormalizedData;
}
export interface AppSettings {
  outputFolder: string | null;
  paidQueriesApproved: boolean;
}
export interface QueryOutcome {
  path: string;
  queryCode?: string;
  savedAt: string;
  recordId?: string;
  reused?: boolean;
}
export interface HistoryEntry {
  id:string; kind?:'person'|'pis'|'company'; cpf:string; cnpj?:string; requestedAt:string; updatedAt:string; queryCode?:string; status:'uncertain'|'pending'|'paused'|'ready'|'pis_unavailable'; lastIssue?:string; pdfPaths:string[];
}
export type QueryExecution = {state:'pending';recordId:string;queryCode:string} | {state:'ready';pdf:QueryOutcome};
export type PisQueryExecution = {state:'ready';pdf:QueryOutcome} | {state:'no_pis';recordId:string;queryCode?:string;reused?:boolean};
export type QueryUpdate = {kind:'person'|'company';recordId:string;state:'ready'|'paused';message?:string};
export interface AuthOutcome {remembered:boolean;warning?:string}
export interface RememberedCredentials {email:string;password:string}
export interface CredentialStatus {hasSaved:boolean}
export interface BackupResult { path:string; size:number; createdAt:string }
export interface MaintenanceSelection { pdfs:boolean; history:boolean }
export interface MaintenancePreview { recordCount:number; pdfCount:number; pendingCount:number }
export interface MaintenanceResult { deletedPdfs:number; missingPdfs:number; deletedRecords:number; cancelled:boolean }
export interface CpiBrowserStatus { state: 'closed' | 'open'; host?: string }
export interface CpiControlInfo { tag: string; id?: string; name?: string; type?: string; role?: string }
export interface CpiDomInspection { controls: CpiControlInfo[]; truncated: boolean; framesInspected: number }
export interface CpiPendingFilterResult { typeId:'29'; total:number|null; state:'empty'|'found'|'unconfirmed' }
export interface CpiPendingRowId { pesquisaId:string; solicitacaoId:string }
export interface CpiPendingPersonDetail { pesquisaId:string; solicitacaoId:string; cpfValidated:true; cpfMasked:string; status:'aguardando' }
export interface CpiPendingRowsInspection { state:'empty'|'mapped'|'needs_mapping'|'unconfirmed'; total:number|null; visibleRows:number; rows:CpiPendingRowId[]; framesInspected:number; message:string }
export type CpiPersonHistoryState = 'no_history'|'not_ready'|'folder_unconfigured'|'pdf_unavailable'|'pdf_available';
export interface CpiPersonHistoryResult { state:CpiPersonHistoryState; pesquisaId:string; solicitacaoId:string; recordDate?:string }
export type CpiPersonPreparationState = 'requires_paid_authorization' | 'folder_unconfigured' | 'manual_review' | 'pending' | 'pdf_ready';
export interface CpiPersonPreparationResult extends CpiPendingRowId { state:CpiPersonPreparationState; reused:boolean }
export interface CpiHistoryItem extends CpiPendingRowId {
  classification: 'restrictions'|'information';
  answeredAt: string;
  pdfAvailable: boolean;
}
export interface CpiHistoryOverview {
  completedCount: number;
  reviewCount: number;
  items: CpiHistoryItem[];
}
export type CpiPendingWorkflowStage='review_required'|'verification_required'|'submit_started'|'query_started';
export type CpiVerificationReason='confirmed'|'remote_unverified'|'remote_unavailable'|'local_incomplete';
export interface CpiPendingWorkflowItem extends CpiPendingRowId {
  stage:CpiPendingWorkflowStage;
  reviewReason?:import('./judicial.ts').JudicialIssueCode;
  lastVerificationReason?:CpiVerificationReason;
  createdAt?:string;
  submittedAt?:string;
  updatedAt:string;
  lastCheckedAt?:string;
}
export interface CpiPendingWorkflowPage {total:number;page:number;pageSize:number;items:CpiPendingWorkflowItem[]}
export interface CpiWorkflowVerificationResult {stage:CpiPendingWorkflowStage|'completed';reason:CpiVerificationReason;checkedAt:string}
/** Estado do FULL AUTO para a interface: somente códigos CPI, contadores e durações (nunca CPF). */
export interface CpiAutoSnapshot {
  phase:'stopped'|'running'|'waiting'|'paused'|'error';
  checks:number;lastMessage:string;nextCheckAt:string|null;
  /** Teto da espera com fila vazia, em segundos (não limita a quantidade de itens). */
  intervalSeconds:number;
  currentItem:CpiPendingRowId|null;
  cycleStartedAt:string|null;
  lastCycleMs:number|null;
  counters:{completed:number;review:number;failures:number;pending:number};
  failureStreak:{kind:string;count:number}|null;
}
export interface CpiMonitorSnapshot {
  phase: 'stopped'|'checking'|'waiting'|'paused'|'needs_mapping'|'error';
  intervalSeconds: number; checks: number; lastCheckedAt: string|null; nextCheckAt: string|null;
  lastTotal: number|null; lastResult: CpiPendingFilterResult['state']|null; message: string|null;
}
export interface DesktopApi {
  cpiAutoStatus():Promise<CpiAutoSnapshot>;
  cpiAutoStart(seconds:number):Promise<CpiAutoSnapshot>;
  cpiAutoPause():Promise<CpiAutoSnapshot>;
  subscribeCpiAuto(callback:(value:CpiAutoSnapshot)=>void):()=>void;
  cpiHistory():Promise<CpiHistoryOverview>;
  cpiPendingWorkflows(page:number,pageSize:number):Promise<CpiPendingWorkflowPage>;
  cpiVerifyWorkflow(ids:CpiPendingRowId):Promise<CpiWorkflowVerificationResult>;
  cpiOpenHistoryPdf(ids:CpiPendingRowId):Promise<void>;
  cpiOpen(): Promise<CpiBrowserStatus>;
  cpiStatus(): Promise<CpiBrowserStatus>;
  cpiInspect(): Promise<CpiDomInspection>;
  cpiFilterPerson29():Promise<CpiPendingFilterResult>;
  cpiInspectPendingRows():Promise<CpiPendingRowsInspection>;
  cpiInspectPendingPersonDetails(ids:CpiPendingRowId):Promise<CpiPendingPersonDetail>;
  cpiInspectPersonHistory(ids:CpiPendingRowId):Promise<CpiPersonHistoryResult>;
  cpiPreparePersonPdf(ids:CpiPendingRowId):Promise<CpiPersonPreparationResult>;
  cpiClose(): Promise<void>;
  cpiMonitorStart(intervalSeconds:number):Promise<CpiMonitorSnapshot>;
  cpiMonitorPause():Promise<CpiMonitorSnapshot>;
  cpiMonitorStatus():Promise<CpiMonitorSnapshot>;
  subscribeCpiMonitor(callback:(snapshot:CpiMonitorSnapshot)=>void):()=>void;
  getSettings(): Promise<AppSettings>;
  maintenancePreview():Promise<MaintenancePreview>;
  createBackup():Promise<BackupResult>;
  openBackupFolder():Promise<void>;
  openDiagnosticsFolder():Promise<void>;
  cleanLocalData(selection:MaintenanceSelection):Promise<MaintenanceResult>;
  chooseFolder(): Promise<AppSettings>;
  setPaidQueriesApproved(approved: boolean): Promise<AppSettings>;
  authenticate(email: string, password: string, remember: boolean): Promise<AuthOutcome>;
  credentialsStatus(): Promise<CredentialStatus>;
  loadSavedCredentials(): Promise<RememberedCredentials | null>;
  forgetSavedCredentials(): Promise<void>;
  logout(): Promise<void>;
  credits(): Promise<number>;
  queryAndSave(cpf: string): Promise<QueryExecution>;
  queryPisAndSave(cpf:string):Promise<PisQueryExecution>;
  queryCompanyAndSave(cnpj:string):Promise<QueryExecution>;
  companyHistory():Promise<HistoryEntry[]>;
  resumeQuery(recordId:string):Promise<QueryExecution>;
  subscribeQueryUpdates(callback:(update:QueryUpdate)=>void):()=>void;
  regenerateCompany(recordId:string):Promise<QueryExecution>;
  pisHistory():Promise<HistoryEntry[]>;
  regeneratePis(recordId:string):Promise<PisQueryExecution>;
  saveAgain(): Promise<QueryOutcome>;
  reprocessLast(): Promise<QueryOutcome>;
  recoveryStatus(): Promise<{hasResponse:boolean;hasReport:boolean}>;
  openFolder(): Promise<void>;
  openLastPdf(): Promise<void>;
  history():Promise<HistoryEntry[]>;
  openHistoryPdf(recordId:string,path:string):Promise<void>;
  recoverByCode(cpf:string,code:string):Promise<QueryExecution>;
  regenerateHistory(recordId:string):Promise<QueryExecution>;
}

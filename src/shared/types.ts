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
export interface DesktopApi {
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

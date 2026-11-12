import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, QueryUpdate, CpiMonitorSnapshot, CpiAutoSnapshot, CpiPendingRowId } from '../shared/types.ts';

const api:DesktopApi={
  cpiAutoStatus:()=>ipcRenderer.invoke('cpi:auto:status'),
  cpiAutoStart:seconds=>ipcRenderer.invoke('cpi:auto:start',seconds),
  cpiAutoPause:()=>ipcRenderer.invoke('cpi:auto:pause'),
  subscribeCpiAuto:callback=>{
    const listener=(_event:Electron.IpcRendererEvent,snapshot:CpiAutoSnapshot)=>callback(snapshot);
    ipcRenderer.on('cpi:auto:updated',listener);
    return ()=>ipcRenderer.removeListener('cpi:auto:updated',listener);
  },
  cpiHistory:()=>ipcRenderer.invoke('cpi:history:list'),
  cpiPendingWorkflows:(page,pageSize)=>ipcRenderer.invoke('cpi:workflow:pending',page,pageSize),
  cpiVerifyWorkflow:ids=>ipcRenderer.invoke('cpi:workflow:verify',ids),
  cpiOpenHistoryPdf:ids=>ipcRenderer.invoke('cpi:history:open-pdf',ids),
  cpiOpen:()=>ipcRenderer.invoke('cpi:open'),
  cpiStatus:()=>ipcRenderer.invoke('cpi:status'),
  cpiInspect:()=>ipcRenderer.invoke('cpi:inspect'),
  cpiFilterPerson29:()=>ipcRenderer.invoke('cpi:filter-person-29'),
  cpiInspectPendingRows:()=>ipcRenderer.invoke('cpi:rows:inspect'),
  cpiInspectPendingPersonDetails:(ids:CpiPendingRowId)=>ipcRenderer.invoke('cpi:details:inspect',ids),
  cpiInspectPersonHistory:(ids:CpiPendingRowId)=>ipcRenderer.invoke('cpi:person:history',ids),
  cpiPreparePersonPdf:(ids:CpiPendingRowId)=>ipcRenderer.invoke('cpi:person:prepare',ids),
  cpiClose:()=>ipcRenderer.invoke('cpi:close'),
  cpiMonitorStart:intervalSeconds=>ipcRenderer.invoke('cpi:monitor:start',intervalSeconds),
  cpiMonitorPause:()=>ipcRenderer.invoke('cpi:monitor:pause'),
  cpiMonitorStatus:()=>ipcRenderer.invoke('cpi:monitor:status'),
  subscribeCpiMonitor:callback=>{
    const listener=(_event:Electron.IpcRendererEvent,snapshot:CpiMonitorSnapshot)=>callback(snapshot);
    ipcRenderer.on('cpi:monitor:updated',listener);
    return ()=>ipcRenderer.removeListener('cpi:monitor:updated',listener);
  },
  getSettings:()=>ipcRenderer.invoke('settings:get'),
  maintenancePreview:()=>ipcRenderer.invoke('maintenance:preview'),
  createBackup:()=>ipcRenderer.invoke('backup:create'),
  openBackupFolder:()=>ipcRenderer.invoke('backup:open-folder'),
  openDiagnosticsFolder:()=>ipcRenderer.invoke('diagnostics:open-folder'),
  cleanLocalData:selection=>ipcRenderer.invoke('maintenance:clean',selection),
  chooseFolder:()=>ipcRenderer.invoke('settings:choose-folder'),
  setPaidQueriesApproved:approved=>ipcRenderer.invoke('settings:approve',approved),
  authenticate:(email,password,remember)=>ipcRenderer.invoke('auth:login',email,password,remember),
  credentialsStatus:()=>ipcRenderer.invoke('credentials:status'),
  loadSavedCredentials:()=>ipcRenderer.invoke('credentials:load'),
  forgetSavedCredentials:()=>ipcRenderer.invoke('credentials:forget'),
  logout:()=>ipcRenderer.invoke('auth:logout'),
  credits:()=>ipcRenderer.invoke('api:credits'),
  queryAndSave:cpf=>ipcRenderer.invoke('api:query',cpf),
  queryPisAndSave:cpf=>ipcRenderer.invoke('pis:query',cpf),
  queryCompanyAndSave:cnpj=>ipcRenderer.invoke('company:query',cnpj),
  companyHistory:()=>ipcRenderer.invoke('company:history'),
  resumeQuery:recordId=>ipcRenderer.invoke('queries:resume',recordId),
  subscribeQueryUpdates:callback=>{
    const listener=(_event:Electron.IpcRendererEvent,update:QueryUpdate)=>callback(update);
    ipcRenderer.on('queries:updated',listener);
    return ()=>ipcRenderer.removeListener('queries:updated',listener);
  },
  regenerateCompany:recordId=>ipcRenderer.invoke('company:regenerate',recordId),
  pisHistory:()=>ipcRenderer.invoke('pis:history'),
  regeneratePis:recordId=>ipcRenderer.invoke('pis:regenerate',recordId),
  saveAgain:()=>ipcRenderer.invoke('report:save-again'),
  reprocessLast:()=>ipcRenderer.invoke('report:reprocess'),
  recoveryStatus:()=>ipcRenderer.invoke('report:recovery-status'),
  openFolder:()=>ipcRenderer.invoke('report:open-folder'),
  openLastPdf:()=>ipcRenderer.invoke('report:open-pdf'),
  history:()=>ipcRenderer.invoke('history:list'),
  openHistoryPdf:(recordId,path)=>ipcRenderer.invoke('history:open-pdf',recordId,path),
  recoverByCode:(cpf,code)=>ipcRenderer.invoke('history:recover-code',cpf,code),
  regenerateHistory:recordId=>ipcRenderer.invoke('history:regenerate',recordId)
};
contextBridge.exposeInMainWorld('deskdata',api);

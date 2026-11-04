import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, QueryUpdate } from '../shared/types.ts';

const api:DesktopApi={
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

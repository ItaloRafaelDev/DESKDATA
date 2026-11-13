import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, session, type IpcMainInvokeEvent } from 'electron';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackupService } from './backup.ts';
import { CpiBrowser } from './cpi/cpi-browser.ts';
import { CpiPendingMonitor } from './cpi/pending-monitor.ts';
import { CpiWorkflowStore } from './cpi/workflow-store.ts';
import { CpiFullAutoRunner } from './cpi/full-auto-runner.ts';
import { CpiQueueSelector } from './cpi/queue-selection.ts';
import { createCpiScan } from './cpi/full-auto-orchestrator.ts';
import { DiagnosticLogger } from './diagnostics.ts';
import { PersonReportService } from './person-reports.ts';
import { DeskdataClient } from './deskdata-client.ts';
import { getSettings, pickOutputFolder, saveOutputFolder } from './settings.ts';
import { DialogGuard } from './dialog-guard.ts';
import { saveCompanyReportPdf, saveCpiReportPdf, saveReportPdf, savePisReportPdf } from './pdf.ts';
import { CredentialStore } from './credentials.ts';
import { AccountApprovalStore } from './account-approval.ts';
import { QueryHistoryStore } from './query-history.ts';
import { PendingQueryMonitor } from './pending-queries.ts';
import { MaintenanceService } from './maintenance.ts';
import { OperationGate, settleWithin } from './operation-gate.ts';
import { IPC_EVENTS } from '../shared/ipc-contract.ts';
import { createBinder, CPI_AUTO_HOLDER, CPI_MONITOR_HOLDER } from './ipc/bind.ts';
import { sessionChanging, showHistoryChange, toError, type MainContext, type SessionState } from './ipc/context.ts';
import { completePending } from './ipc/recovery.ts';
import { registerAuthIpc } from './ipc/auth.ts';
import { registerPersonIpc } from './ipc/person.ts';
import { registerPisIpc } from './ipc/pis.ts';
import { registerCompanyIpc } from './ipc/company.ts';
import { registerCpiIpc } from './ipc/cpi.ts';
import { registerMaintenanceIpc } from './ipc/maintenance.ts';
import { registerSettingsIpc } from './ipc/settings.ts';

// Raiz de composição (E5): inicializa serviços, monta o contexto e registra os canais por domínio (`ipc/*`).
const currentDir = dirname(fileURLToPath(import.meta.url));
const client=new DeskdataClient();
// Única fonte de estado de concorrência (E4): exclusividade, segundo plano, reentrada e encerramento.
const gate=new OperationGate();
const dialogs=new DialogGuard();
const cpiBrowser=new CpiBrowser();
const cpiQueue=new CpiQueueSelector();
// Estado de sessão em memória, compartilhado com os módulos IPC pelo contexto. Nada aqui é persistido.
const sessionState:SessionState={account:null,lastSavedPdf:null,lastCompanyResponse:null,lastPisResponse:null};
let mainWindow:BrowserWindow|undefined;
let history:QueryHistoryStore|undefined;
let personReports:PersonReportService|undefined;
let monitor:PendingQueryMonitor|undefined;
let diagnostics:DiagnosticLogger|undefined;
let cpiAuto:CpiFullAutoRunner|undefined;

function sendToWindow(channel:string,payload:unknown):void{
  if(mainWindow&&!mainWindow.isDestroyed()&&!mainWindow.webContents.isDestroyed())mainWindow.webContents.send(channel,payload);
}
const cpiMonitor=new CpiPendingMonitor(
  () => gate.run(()=>cpiBrowser.filterPendingPerson29(),{exclusive:true,holder:CPI_MONITOR_HOLDER}),
  snapshot => sendToWindow(IPC_EVENTS.cpiMonitor,snapshot)
);
function guard(event:IpcMainInvokeEvent):void {
  if(!mainWindow || event.sender.id!==mainWindow.webContents.id || event.senderFrame!==mainWindow.webContents.mainFrame)throw new Error('Origem IPC não autorizada.');
}
function createMainWindow():void{
  const window=mainWindow=new BrowserWindow({
    width:1180,height:780,minWidth:880,minHeight:640,show:false,autoHideMenuBar:true,backgroundColor:'#f4f7fb',title:'DESKDATA',
    webPreferences:{preload:join(currentDir,'../preload/index.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true}
  });
  window.once('ready-to-show',()=>window.show());
  window.on('close',event=>{
    if(!gate.isShutdownReady()){event.preventDefault();app.quit();}
  });
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',e=>e.preventDefault());
  if(!app.isPackaged && process.env.ELECTRON_RENDERER_URL){
    const url=new URL(process.env.ELECTRON_RENDERER_URL);
    if(!['localhost','127.0.0.1'].includes(url.hostname) || url.protocol!=='http:') throw new Error('URL do servidor DEV não autorizada.');
    void window.loadURL(url.href);
  } else void window.loadFile(join(currentDir,'../renderer/index.html'));
}
// Preserva a identidade da pasta de dados entre o ambiente DEV e o aplicativo instalado.
const stableDataDirectory=join(app.getPath('appData'),'deskdata-desktop');
mkdirSync(stableDataDirectory,{recursive:true});
app.setPath('userData',stableDataDirectory);
const instanceLock=app.requestSingleInstanceLock();
if(!instanceLock)app.quit();
app.on('second-instance',()=>{if(mainWindow && !mainWindow.isDestroyed()){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.focus();}});
if(instanceLock)app.whenReady().then(()=>{
  const protector = {
    isAvailable:()=>safeStorage.isAsyncEncryptionAvailable(),
    encrypt:(data:string)=>safeStorage.encryptStringAsync(data),
    decrypt:(data:Buffer)=>safeStorage.decryptStringAsync(data)
  };
  const dataDir=app.getPath('userData');
  const logger=diagnostics=new DiagnosticLogger(join(dataDir,'logs'));
  void logger.write('app_started',{state:'success'}).catch(()=>{});
  const store=history=new QueryHistoryStore(dataDir,protector);
  const reports=personReports=new PersonReportService({history:store,
    currentAccount:()=>sessionChanging(ctx)?null:sessionState.account,
    getOutputFolder:async()=>(await getSettings()).outputFolder,
    savePdf:saveReportPdf});
  // `scan` e `ctx` são declarados abaixo; os callbacks só rodam depois do registro dos canais (`start`, recuperação).
  const runner=cpiAuto=new CpiFullAutoRunner(context=>gate.run(()=>scan(context),{exclusive:true,holder:CPI_AUTO_HOLDER}),
    snapshot=>sendToWindow(IPC_EVENTS.cpiAuto,snapshot));
  const pendingMonitor=monitor=new PendingQueryMonitor({
    get:code=>gate.run(()=>client.checkByCode(code)),
    complete:(target,payload)=>gate.run(()=>completePending(ctx,target,payload),{background:true}),
    pause:(target,message)=>gate.run(async()=>{
      if(sessionState.account!==target.account)return;
      await store.setPaused(target.id,message);
      showHistoryChange(ctx,{kind:target.kind,recordId:target.id,state:'paused',message});
    })
  });
  const ctx:MainContext={
    session:sessionState,gate,client,cpiBrowser,cpiMonitor,cpiAuto:runner,cpiQueue,dialogs,
    cpiWorkflow:new CpiWorkflowStore(dataDir,protector),history:store,personReports:reports,monitor:pendingMonitor,
    maintenance:new MaintenanceService(store),
    backups:new BackupService({userData:dataDir,backupDirectory:app.isPackaged?join(dataDir,'backups'):join(app.getAppPath(),'backups'),history:store,protector,getSettings}),
    approvals:new AccountApprovalStore(dataDir,protector),credentials:new CredentialStore(dataDir,protector),
    cpiRehearsal:!app.isPackaged&&process.env.DESKDATA_CPI_ENSAIO==='1',
    diagnostics:logger,dataDir,getSettings,pickOutputFolder,saveOutputFolder,
    pdf:{saveCpiReportPdf,savePisReportPdf,saveCompanyReportPdf},
    showMessageBox:options=>mainWindow?dialog.showMessageBox(mainWindow,options):dialog.showMessageBox(options),
    openPath:path=>shell.openPath(path),
    getMainWindow:()=>mainWindow
  };
  const scan=createCpiScan(ctx);
  session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  const bind=createBinder({
    handle:(channel,listener)=>ipcMain.handle(channel,listener),guard,gate,
    cpiActive:()=>({auto:runner.isActive(),monitor:cpiMonitor.isActive()}),
    pauseCpi:()=>Promise.all([runner.pause(),cpiMonitor.stopAndWait()]),
    write:(event,fields)=>logger.write(event,fields),
    // Canais de inspeção manual da CPI só existem fora do aplicativo instalado (E5).
    isDev:!app.isPackaged
  });
  registerSettingsIpc(bind,ctx);
  registerMaintenanceIpc(bind,ctx);
  registerCpiIpc(bind,ctx);
  registerAuthIpc(bind,ctx);
  registerPersonIpc(bind,ctx);
  registerPisIpc(bind,ctx);
  registerCompanyIpc(bind,ctx);
  createMainWindow();
}).catch(e=>{void diagnostics?.write('startup_error',{errorType:toError(e).name}).catch(()=>{});console.error('Falha na inicialização:',toError(e).name);app.quit();});
// Antes de finalizar, aguarda as operações aceitas e libera o handle do SQLite.
// Não apaga nem recria o banco. A marca de migração e a chave permanecem no disco.
// Fases do encerramento ficam no gate: open → closing → ready (ou blocked se o banco já começou a fechar).
app.on('before-quit',event=>{
  if(gate.isShutdownReady())return;
  event.preventDefault();
  if(!gate.requestShutdown())return;
  dialogs.cancelAll();
  monitor?.stopAll();
  // Interromper novos agendamentos agora, preservando o ciclo e a sessão em curso.
  const stopping:Promise<unknown>[]=[cpiAuto?.pause()??Promise.resolve(),cpiMonitor.stopAndWait()];
  const started=performance.now();
  let databaseCloseStarted=false;
  void (async()=>{
    if(!await gate.waitForIdle(stopping))throw new Error('ShutdownTimeoutError');
    await gate.drainBackground();
    if(!await settleWithin(cpiBrowser.close(),60_000-(performance.now()-started)))throw new Error('ShutdownTimeoutError');
    databaseCloseStarted=true;
    await history?.close();
    client.reset();sessionState.account=null;personReports?.clear();
    gate.markShutdownReady();
    app.quit();
  })().catch(error=>{
    // Não registrar payloads, tokens ou identificadores nos diagnósticos.
    console.error('Falha ao encerrar o histórico SQLite:',toError(error).name);
    gate.shutdownFailed(databaseCloseStarted);
    if(mainWindow&&!mainWindow.isDestroyed()){
      void dialog.showMessageBox(mainWindow,{type:'warning',title:'Encerramento adiado',
        message:'O aplicativo permanece aberto para preservar as operações e o histórico.',
        detail:databaseCloseStarted
          ? 'Não foi possível fechar o banco com segurança. Novas operações permanecem bloqueadas; tente sair novamente. O histórico e a sessão não foram descartados.'
          : 'Uma operação não terminou com segurança dentro do prazo de encerramento ou houve falha ao liberar recursos. Aguarde antes de tentar sair novamente. Uma consulta paga ou resposta CPI pode ter resultado incerto: verifique o histórico e não repita o envio.',
        buttons:['Entendido']}).catch(()=>{});
    }
  });
});
app.on('window-all-closed',()=>{app.quit();});

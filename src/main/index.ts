import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, session, type IpcMainInvokeEvent } from 'electron';
import { stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { BackupService } from './backup.ts';
import { DiagnosticLogger } from './diagnostics.ts';
import { extname } from 'node:path';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const currentDir = dirname(fileURLToPath(import.meta.url));
import { cnpjDigits, isValidCnpj } from '../shared/cnpj.ts';
import { assertRecoveredCnpj } from '../shared/company-identity.ts';
import { normalizeCompanyResponse } from '../shared/company-report.ts';
import { isValidCpf, cpfDigits } from '../shared/cpf.ts';
import { normalizeDeskdataResponse } from '../shared/normalizer.ts';
import { assertRecoveredCpf } from '../shared/query-identity.ts';
import { QueryRecovery, type ReceivedQuery } from '../shared/query-recovery.ts';
import type { ReportPayload, QueryOutcome, QueryExecution, QueryUpdate, PisQueryExecution } from '../shared/types.ts';
import { DeskdataClient } from './deskdata-client.ts';
import { chooseFolder, getSettings } from './settings.ts';
import { saveCompanyReportPdf, saveReportPdf, savePisReportPdf } from './pdf.ts';
import { resolvePisOutcome } from './pis-outcome.ts';
import { CredentialStore } from './credentials.ts';
import { AccountApprovalStore } from './account-approval.ts';
import { QueryHistoryStore, type QueryRecord } from './query-history.ts';
import { PendingQueryMonitor, type PendingTarget } from './pending-queries.ts';
import { MaintenanceService } from './maintenance.ts';
import type { MaintenanceSelection, MaintenanceResult } from '../shared/types.ts';

const client=new DeskdataClient();
const queryRecovery = new QueryRecovery();
let mainWindow:BrowserWindow;
let busy=false;
let lastReport:ReportPayload|null=null;
let lastSavedPdf:string|null=null;
let history:QueryHistoryStore;
let monitor:PendingQueryMonitor;
let maintenance:MaintenanceService;
let backups:BackupService;
let diagnostics:DiagnosticLogger;
let maintenanceActive=false;
let sessionTransitionActive=false;
let approvals:AccountApprovalStore;
const activeCompletions=new Set<Promise<void>>();
let sessionAccount:string|null=null;
let lastRecordId:string|null=null;
let lastCompanyResponse:{cnpj:string;payload:unknown;queryCode?:string}|null=null;
let lastPisResponse:{cpf:string;payload:unknown;queryCode?:string}|null=null;

function guard(event:IpcMainInvokeEvent):void {
  if(!mainWindow || event.sender.id!==mainWindow.webContents.id || event.senderFrame!==mainWindow.webContents.mainFrame)throw new Error('Origem IPC não autorizada.');
}
function bind<T extends unknown[]>(channel:string,operation:(...args:T)=>Promise<unknown>):void{
  ipcMain.handle(channel,async(event,...args:unknown[])=>{
    guard(event);
    const began=performance.now();
    try {
      const result=await operation(...(args as T));
      void diagnostics?.write('ipc_success',{channel,durationMs:performance.now()-began}).catch(()=>{});
      return result;
    } catch(error){
      void diagnostics?.write('ipc_error',{channel,durationMs:performance.now()-began,errorType:toError(error).name}).catch(()=>{});
      throw error;
    }
  });
}
function account():string {if(sessionTransitionActive)throw new Error('Troca de sessão em andamento.');if(!sessionAccount)throw new Error('Autentique-se antes de consultar o histórico.');return sessionAccount;}
async function approvedForCurrentAccount():Promise<boolean> {return approvals.isApproved(account());}
async function viewSettings(){const settings=await getSettings();return {...settings,paidQueriesApproved:sessionAccount && !sessionTransitionActive?await approvals.isApproved(sessionAccount):false};}
async function assertPaidQueryApproved(){if(!await approvedForCurrentAccount())throw new Error('Autorize novas consultas para esta conta em Minha conta.');}
function toError(e:unknown):Error { return e instanceof Error?e:new Error('Ocorreu um erro não identificado.'); }
async function exportReport(report:ReportPayload,recordId:string|null=lastRecordId):Promise<QueryOutcome>{
  const {outputFolder}=await getSettings();
  if(!outputFolder)throw new Error('Selecione antes a pasta de destino dos PDFs.');
  const result=await saveReportPdf(outputFolder,report);
  lastSavedPdf=result.path;
  if(recordId)await history.addPdf(recordId,result.path);
  return {...result,recordId:recordId??undefined};
}
async function processReceived(result: ReceivedQuery,recordId:string): Promise<QueryOutcome> {
  lastRecordId=recordId;
  const data = normalizeDeskdataResponse(result.payload);
  lastReport = {cpf: result.cpf, consultedAt: result.consultedAt, queryCode: result.queryCode, data};
  return exportReport(lastReport,recordId);
}
async function reprocessLastResponse(): Promise<QueryOutcome> {
  if (busy) throw new Error('Já existe uma operação em execução.');
  const cached = queryRecovery.read();
  if (!cached) throw new Error('Nenhuma resposta de consulta está disponível nesta sessão.');
  busy = true;
  try {if(!lastRecordId)throw new Error('Registro local indisponível para reprocessamento.');return await processReceived(cached,lastRecordId); } finally { busy = false; }
}
async function validateStoredPdf(path:string):Promise<boolean>{
  if(extname(path).toLowerCase()!=='.pdf')return false;
  try {return (await stat(path)).isFile();} catch{return false;}
}
function ready(pdf:QueryOutcome):QueryExecution {return {state:'ready',pdf};}
function showHistoryChange(update:QueryUpdate):void{
  void diagnostics?.write('query_update',{state:update.state}).catch(()=>{});
  if(mainWindow && !mainWindow.isDestroyed())mainWindow.webContents.send('queries:updated',update);
}
function targetFrom(record:QueryRecord):PendingTarget {
  if(!record.queryCode)throw new Error('Consulta sem código recuperável.');
  if(record.kind==='company')return {id:record.id,kind:'company',account:record.account,cnpj:record.cnpj,queryCode:record.queryCode};
  return {id:record.id,kind:'person',account:record.account,cpf:record.cpf,queryCode:record.queryCode};
}
async function pending(record:QueryRecord,immediate=false):Promise<QueryExecution>{
  if(!record.queryCode)throw new Error('Consulta sem código para recuperação automática.');
  if(!monitor.isWatching(record.id)){
    await history.setPending(record.id);
    monitor.watch(targetFrom(record),immediate);
  }
  return {state:'pending',recordId:record.id,queryCode:record.queryCode};
}
async function resolveRecorded(record:QueryRecord):Promise<QueryExecution>{
  if(!record.queryCode)throw new Error('Código recuperável indisponível.');
  if(monitor.isWatching(record.id))return {state:'pending',recordId:record.id,queryCode:record.queryCode};
  const received=await client.checkByCode(record.queryCode);
  if(received.state==='pending')return pending(record);
  if(record.kind==='company' && record.cnpj){
    assertRecoveredCnpj(received.payload,record.cnpj);
    return ready({...await exportCompany(record.cnpj,received.payload,record.id,record.queryCode),reused:true});
  }
  assertRecoveredCpf(received.payload,record.cpf);
  const result:ReceivedQuery={cpf:record.cpf,consultedAt:new Date().toISOString(),queryCode:record.queryCode,payload:received.payload};
  queryRecovery.remember(result);
  return ready({...await processReceived(result,record.id),reused:true});
}
async function completePending(target:PendingTarget,payload:unknown):Promise<void>{
  const work=(async()=>{
    if(maintenanceActive) return;
  if(sessionAccount!==target.account)throw new Error('Sessão encerrada durante recuperação.');
  const current=await history.findById(target.account,target.id);
  if(!current || current.status==='ready')return;
  if(target.kind==='company'){
    if(!target.cnpj)throw new Error('CNPJ ausente do histórico de consulta.');
    assertRecoveredCnpj(payload,target.cnpj);
    await exportCompany(target.cnpj,payload,target.id,target.queryCode);
  }else{
    if(!target.cpf)throw new Error('CPF ausente do histórico de consulta.');
    assertRecoveredCpf(payload,target.cpf);
    const received:ReceivedQuery={cpf:target.cpf,consultedAt:new Date().toISOString(),queryCode:target.queryCode,payload};
    queryRecovery.remember(received);
    await processReceived(received,target.id);
  }
  showHistoryChange({kind:target.kind,recordId:target.id,state:'ready'});
  })();
  activeCompletions.add(work);
  try{await work;}finally{activeCompletions.delete(work);}
}
async function resumeAfterAuthentication(who:string):Promise<void>{
  for(const kind of ['person','company'] as const){
    for(const row of await history.list(who,kind)){
      if(row.status==='pending' && row.queryCode)monitor.watch(targetFrom(row),true);
    }
  }
}
async function resumePending(recordId:string):Promise<QueryExecution>{
  const who=account();
  const record=await history.findById(who,recordId);
  if(!record || (record.kind!=='person'&&record.kind!==undefined&&record.kind!=='company'))throw new Error('Registro de pessoa ou empresa não encontrado.');
  if(!record.queryCode)throw new Error('Esta consulta não possui código recuperável.');
  if(record.status==='ready' && record.pdfPaths.length){
    for(const path of [...record.pdfPaths].reverse())if(await validateStoredPdf(path))return ready({path,savedAt:record.updatedAt,recordId:record.id,queryCode:record.queryCode,reused:true});
  }
  return pending(record,true);
}
async function queryAndSave(rawCpf:string):Promise<QueryExecution>{
  if(busy)throw new Error('Já existe uma operação em execução.');
  if(typeof rawCpf!=='string'||!isValidCpf(rawCpf))throw new Error('CPF inválido.');
  const cpf=cpfDigits(rawCpf);
  const settings=await getSettings();
  if(!settings.outputFolder)throw new Error('Configure a pasta de destino antes de consultar.');
  const who=account();
  busy=true;
  try {
    const previous=await history.findLatest(who,cpf);
    if(previous){
      const validPaths=[];
      for(const file of [...previous.pdfPaths].reverse())if(await validateStoredPdf(file))validPaths.push(file);
      if(validPaths.length){
        lastReport=null;lastSavedPdf=validPaths[0];lastRecordId=previous.id;
        return ready({path:validPaths[0],savedAt:previous.updatedAt,queryCode:previous.queryCode,recordId:previous.id,reused:true});
      }
      if(!previous.queryCode){
        if(queryRecovery.matches(cpf)){
          const cached=queryRecovery.read();
          if(cached)return ready(await processReceived(cached,previous.id));
        }
        throw new Error('Existe uma consulta anterior deste CPF sem PDF disponível nem código recuperável. Nenhum novo POST foi enviado. Verifique o histórico antes de autorizar outra consulta.');
      }
      return resolveRecorded(previous);
    }
    await assertPaidQueryApproved();
    const credits=await client.credits();
    if(credits<=0)throw new Error('Saldo de créditos indisponível ou zerado.');
    // Registro cifrado ANTES do POST. Se a conexão cair, não repetimos uma operação potencialmente cobrada.
    const record=await history.begin(who,cpf);
    lastRecordId=record.id;
    const outcome=await client.submitCpf(cpf,code=>history.setCode(record.id,code));
    if(outcome.state==='pending')return pending({...record,queryCode:outcome.queryCode});
    const received:ReceivedQuery={cpf,consultedAt:new Date().toISOString(),queryCode:outcome.queryCode,payload:outcome.payload};
    queryRecovery.remember(received);
    lastReport=null;
    return ready(await processReceived(received,record.id));
  }finally{busy=false;}
}
async function regenerateHistory(recordId:string):Promise<QueryExecution>{
  if(busy)throw new Error('Já existe uma operação em execução.');
  const who=account();
  const record=await history.findById(who,recordId);
  if(!record || record.kind==='pis' || record.kind==='company')throw new Error('Consulta não encontrada no histórico de pessoas desta conta.');
  if(!record.queryCode)throw new Error('Esta consulta não possui código recuperável. Não será criado um novo POST.');
  if(!(await getSettings()).outputFolder)throw new Error('Configure a pasta para salvar o novo PDF.');
  busy=true;
  try {
    return resolveRecorded(record);
  }finally{busy=false;}
}
async function recoverByCode(rawCpf:string,code:string):Promise<QueryExecution>{
  if(busy)throw new Error('Já existe uma operação em execução.');
  if(!isValidCpf(rawCpf) || !/^Q-[A-F0-9]{10}$/.test(code))throw new Error('Informe CPF válido e código no formato Q-XXXXXXXXXX.');
  const cpf=cpfDigits(rawCpf);const who=account();
  if(!(await getSettings()).outputFolder)throw new Error('Configure a pasta de destino antes de recuperar.');
  busy=true;
  try {
    let record=await history.findLatest(who,cpf);
    if(record?.queryCode && record.queryCode!==code)throw new Error('Este CPF já está associado a outro código. Nenhuma requisição foi enviada.');
    if(!record)record=await history.begin(who,cpf);
    await history.setCode(record.id,code);
    return resolveRecorded({...record,queryCode:code});
  }finally{busy=false;}
}
async function exportPis(cpf:string,payload:unknown,recordId:string,queryCode?:string):Promise<PisQueryExecution>{
  return resolvePisOutcome({
    cpf,payload,recordId,queryCode,
    markUnavailable:()=>history.markPisUnavailable(recordId),
    save:async(record)=>{
      const folder=(await getSettings()).outputFolder;
      if(!folder)throw new Error('Configure a pasta de destino antes de consultar.');
      const outcome=await savePisReportPdf(folder,record,cpf,queryCode);
      await history.addPdf(recordId,outcome.path);
      lastPisResponse={cpf,payload,queryCode}; // somente memória, sem persistir JSON pessoal
      return outcome;
    }
  });
}
function reusedPis(result:PisQueryExecution):PisQueryExecution {
  return result.state==='ready'
    ? {state:'ready',pdf:{...result.pdf,reused:true}}
    : {...result,reused:true};
}
async function queryPisAndSave(rawCpf:string):Promise<PisQueryExecution>{
  if(busy)throw new Error('Já existe uma operação em execução.');
  if(typeof rawCpf!=='string'||!isValidCpf(rawCpf))throw new Error('CPF inválido.');
  const cpf=cpfDigits(rawCpf);
  const settings=await getSettings();
  if(!settings.outputFolder)throw new Error('Selecione a pasta de destino antes de consultar.');
  const who=account();busy=true;
  try{
    const previous=await history.findLatest(who,cpf,'pis');
    if(previous){
      for(const path of [...previous.pdfPaths].reverse())if(await validateStoredPdf(path)){
        return {state:'ready',pdf:{path,queryCode:previous.queryCode,savedAt:previous.updatedAt,recordId:previous.id,reused:true}};
      }
      // Resultado terminal: não repetir POST nem GET em cada clique. GET manual continua disponível.
      if(previous.status==='pis_unavailable')return {state:'no_pis',recordId:previous.id,queryCode:previous.queryCode,reused:true};
      if(lastPisResponse?.cpf===cpf)return reusedPis(await exportPis(cpf,lastPisResponse.payload,previous.id,lastPisResponse.queryCode));
      if(!previous.queryCode)throw new Error('Consulta PIS anterior sem PDF nem código recuperável. Não repetiremos o POST para evitar nova cobrança.');
      const recovered=await client.fetchByCode(previous.queryCode);
      assertRecoveredCpf(recovered.payload,cpf);
      return reusedPis(await exportPis(cpf,recovered.payload,previous.id,recovered.queryCode));
    }
    // Consulta completa anterior já contém basic: utilizar GET pelo código, sem criar novo POST.
    const person=await history.findLatest(who,cpf,'person');
    if(person?.queryCode){
      const recovered=await client.fetchByCode(person.queryCode);
      assertRecoveredCpf(recovered.payload,cpf);
      const record=await history.begin(who,cpf,'pis');
      await history.setCode(record.id,person.queryCode);
      return reusedPis(await exportPis(cpf,recovered.payload,record.id,person.queryCode));
    }
    await assertPaidQueryApproved();
    if(await client.credits()<=0)throw new Error('Saldo de créditos insuficiente.');
    const record=await history.begin(who,cpf,'pis');
    const result=await client.queryBasicCpf(cpf,code=>history.setCode(record.id,code));
    return exportPis(cpf,result.payload,record.id,result.queryCode);
  }finally{busy=false;}
}
async function regeneratePis(recordId:string):Promise<PisQueryExecution>{
  if(busy)throw new Error('Já existe uma operação em execução.');
  const row=await history.findById(account(),recordId);
  if(!row||row.kind!=='pis')throw new Error('Consulta PIS não encontrada.');
  if(!row.queryCode)throw new Error('Consulta sem código de recuperação disponível.');
  busy=true;
  try{
    const received=await client.fetchByCode(row.queryCode);
    assertRecoveredCpf(received.payload,row.cpf);
    return reusedPis(await exportPis(row.cpf,received.payload,row.id,row.queryCode));
  }finally{busy=false;}
}
async function exportCompany(cnpj:string,payload:unknown,recordId:string,queryCode?:string):Promise<QueryOutcome>{
  const record=normalizeCompanyResponse(payload);
  assertRecoveredCnpj(payload,cnpj);
  const folder=(await getSettings()).outputFolder;
  if(!folder)throw new Error('Configure a pasta de destino antes de consultar.');
  lastCompanyResponse={cnpj,payload,queryCode};
  const saved=await saveCompanyReportPdf(folder,record,cnpj,new Date().toISOString(),queryCode);
  await history.addPdf(recordId,saved.path);
  return {...saved,recordId};
}
async function queryCompanyAndSave(rawCnpj:string):Promise<QueryExecution>{
  if(busy)throw new Error('Já existe uma operação em execução.');
  if(typeof rawCnpj!=='string'||!isValidCnpj(rawCnpj))throw new Error('CNPJ inválido.');
  const cnpj=cnpjDigits(rawCnpj);
  const settings=await getSettings();
  if(!settings.outputFolder)throw new Error('Configure a pasta de destino antes de consultar.');
  const who=account();busy=true;
  try{
    const previous=await history.findLatestCompany(who,cnpj);
    if(previous){
      for(const path of [...previous.pdfPaths].reverse()){
        if(await validateStoredPdf(path))return ready({path,recordId:previous.id,queryCode:previous.queryCode,savedAt:previous.updatedAt,reused:true});
      }
      if(lastCompanyResponse?.cnpj===cnpj)return ready({...await exportCompany(cnpj,lastCompanyResponse.payload,previous.id,lastCompanyResponse.queryCode),reused:true});
      if(!previous.queryCode)throw new Error('Consulta anterior sem PDF nem código recuperável. Não será enviado outro POST automaticamente.');
      return resolveRecorded(previous);
    }
    await assertPaidQueryApproved();
    if(await client.credits()<=0)throw new Error('Saldo de créditos indisponível.');
    const record=await history.beginCompany(who,cnpj); // persistir antes do POST
    const result=await client.submitCompany(cnpj,code=>history.setCode(record.id,code));
    if(result.state==='pending')return pending({...record,queryCode:result.queryCode});
    return ready(await exportCompany(cnpj,result.payload,record.id,result.queryCode));
  }finally{busy=false;}
}
async function regenerateCompany(recordId:string):Promise<QueryExecution>{
  if(busy)throw new Error('Já existe uma operação em execução.');
  const record=await history.findById(account(),recordId);
  if(!record||record.kind!=='company'||!record.cnpj)throw new Error('Consulta empresarial não encontrada.');
  if(!record.queryCode)throw new Error('A consulta não possui código recuperável.');
  busy=true;
  try{
    return resolveRecorded(record);
  }finally{busy=false;}
}
async function saveAgain():Promise<QueryOutcome>{
  if(busy)throw new Error('Aguarde o término da operação atual.');
  if(!lastReport)throw new Error('Não há relatório disponível para novo salvamento nesta sessão.');
  busy=true;
  try{return await exportReport(lastReport);}finally{busy=false;}
}
function createMainWindow():void{
  mainWindow=new BrowserWindow({
    width:1180,height:780,minWidth:880,minHeight:640,show:false,autoHideMenuBar:true,backgroundColor:'#f4f7fb',title:'DESKDATA',
    webPreferences:{preload:join(currentDir,'../preload/index.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true}
  });
  mainWindow.once('ready-to-show',()=>mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  mainWindow.webContents.on('will-navigate',e=>e.preventDefault());
  if(!app.isPackaged && process.env.ELECTRON_RENDERER_URL){
    const url=new URL(process.env.ELECTRON_RENDERER_URL);
    if(!['localhost','127.0.0.1'].includes(url.hostname) || url.protocol!=='http:') throw new Error('URL do servidor DEV não autorizada.');
    void mainWindow.loadURL(url.href);
  } else void mainWindow.loadFile(join(currentDir,'../renderer/index.html'));
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
  diagnostics=new DiagnosticLogger(join(dataDir,'logs'));
  void diagnostics.write('app_started',{state:'success'}).catch(()=>{});
  const credentials = new CredentialStore(dataDir,protector);
  history = new QueryHistoryStore(dataDir,protector);
  approvals = new AccountApprovalStore(dataDir,protector);
  maintenance = new MaintenanceService(history);
  backups=new BackupService({userData:dataDir,backupDirectory:app.isPackaged?join(dataDir,'backups'):join(app.getAppPath(),'backups'),history,protector,getSettings});
  monitor = new PendingQueryMonitor({
    get:code=>client.checkByCode(code),
    complete:completePending,
    pause:async(target,message)=>{
      if(sessionAccount!==target.account)return;
      await history.setPaused(target.id,message);
      showHistoryChange({kind:target.kind,recordId:target.id,state:'paused',message});
    }
  });
  session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  bind('settings:get',()=>viewSettings());
  bind('settings:choose-folder',async()=>{account();await chooseFolder();return viewSettings();});
  bind<[boolean]>('settings:approve',async approved=>{
    const who=account();
    if(typeof approved!=='boolean')throw new Error('Valor inválido.');
    await approvals.setApproved(who,approved);
    return viewSettings();
  });
  bind('maintenance:preview',async()=>{account();return maintenance.preview();});
  bind('backup:create',async()=>{
    account();
    if(busy||maintenanceActive||sessionTransitionActive)throw new Error('Conclua a operação atual antes de criar o backup.');
    busy=true;
    try{const result=await backups.create();
      void diagnostics.write('backup_created',{state:'success'}).catch(()=>{});return result;
    }finally{busy=false;}
  });
  bind('diagnostics:open-folder',async()=>{
    account();
    const logDirectory=join(dataDir,'logs');
    const result=await shell.openPath(logDirectory);
    if(result)throw new Error('Não foi possível abrir a pasta de diagnósticos.');
  });
  bind('backup:open-folder',async()=>{
    account();
    const result=await shell.openPath(backups.directory);
    if(result)throw new Error('Não foi possível abrir a pasta de backups.');
  });
  bind<[MaintenanceSelection]>('maintenance:clean',async(selection):Promise<MaintenanceResult>=>{
    account();
    if(maintenanceActive||busy)throw new Error('Conclua a operação atual antes da limpeza.');
    if(!selection||typeof selection.pdfs!=='boolean'||typeof selection.history!=='boolean'||(!selection.pdfs&&!selection.history))throw new Error('Selecione os dados a limpar.');
    const summary=await maintenance.preview();
    const explanation=[
      selection.pdfs?`${summary.pdfCount} PDF(s) cadastrados no histórico desta instalação serão removidos, quando existentes.`:'Os PDFs permanecerão no disco.',
      selection.history?`${summary.recordCount} registro(s) locais de todas as contas serão apagados, incluindo códigos de recuperação.`:'Os códigos de consulta e o histórico serão mantidos.',
      summary.pendingCount?`Existem ${summary.pendingCount} consulta(s) pendentes ou incertas no histórico.`:'',
      'A exclusão não remove consultas da Deskdata e não pode ser desfeita pelo aplicativo.'
    ].filter(Boolean).join('\n\n');
    const answer=await dialog.showMessageBox(mainWindow,{
      type:'warning',title:'Confirmar limpeza local',message:'Deseja excluir os dados selecionados?',detail:explanation,
      buttons:['Cancelar','Excluir definitivamente'],defaultId:0,cancelId:0,noLink:true
    });
    if(answer.response!==1)return {cancelled:true,deletedPdfs:0,missingPdfs:0,deletedRecords:0};
    maintenanceActive=true;
    busy=true;
    monitor.stopAll();
    try{
      // Uma recuperação já iniciada deve concluir antes de começar a excluir arquivos.
      await Promise.allSettled([...activeCompletions]);
      const result=await maintenance.clean(selection);
      queryRecovery.clear();lastReport=null;lastRecordId=null;lastSavedPdf=null;
      lastCompanyResponse=null;lastPisResponse=null;
      if(!selection.history && sessionAccount)await resumeAfterAuthentication(sessionAccount);
      return {...result,cancelled:false};
    }finally{maintenanceActive=false;busy=false;}
  });
  bind('credentials:status',()=>credentials.status());
  bind('credentials:load',()=>credentials.load());
  bind('credentials:forget',()=>credentials.clear());
  bind<[string,string,boolean]>('auth:login',async(username,password,remember)=>{
    if(typeof username!=='string'||typeof password!=='string'||typeof remember!=='boolean')throw new Error('Credenciais inválidas.');
    if(busy||maintenanceActive||sessionTransitionActive)throw new Error('Conclua a operação atual antes de alterar a sessão.');
    if(sessionAccount)throw new Error('Encerre a sessão atual antes de autenticar outra conta.');
    sessionTransitionActive=true;
    try {
      monitor.stopAll();
      await Promise.allSettled([...activeCompletions]);
      await client.authenticate(username,password);
      sessionAccount=username.trim().toLowerCase();
      await resumeAfterAuthentication(sessionAccount);
      if(!remember)return {remembered:false};
      try {await credentials.save(username,password);return {remembered:true};}
      catch {return {remembered:false,warning:'A autenticação foi concluída, mas as credenciais não puderam ser salvas com segurança neste computador.'};}
    } catch (error) {
      // Se o histórico não puder ser recuperado após /auth, não deixar sessão parcialmente iniciada.
      monitor.stopAll();client.reset();sessionAccount=null;
      throw error;
    } finally {sessionTransitionActive=false;}
  });
  bind('auth:logout',async()=>{
    if(busy||maintenanceActive||sessionTransitionActive)throw new Error('Conclua a operação atual antes de encerrar a sessão.');
    sessionTransitionActive=true;
    try {
      monitor.stopAll();
      await Promise.allSettled([...activeCompletions]);
      client.reset();sessionAccount=null;lastCompanyResponse=null;lastReport=null;lastRecordId=null;lastSavedPdf=null;lastPisResponse=null;queryRecovery.clear();
    }finally{sessionTransitionActive=false;}
  });
  bind('api:credits',()=>client.credits());
  bind<[string]>('api:query',queryAndSave);
  bind<[string]>('queries:resume',resumePending);
  bind<[string]>('pis:query',queryPisAndSave);
  bind<[string]>('company:query',queryCompanyAndSave);
  bind('company:history',async()=> (await history.list(account(),'company')).map(({account:_account,...record})=>record));
  bind<[string]>('company:regenerate',regenerateCompany);
  bind('pis:history',async()=> (await history.list(account(),'pis')).map(({account:_account,...record})=>record));
  bind<[string]>('pis:regenerate',regeneratePis);
  bind('report:save-again',saveAgain);
  bind('history:list',async()=> (await history.list(account(),'person')).map(({account:_account,...record})=>record));
  bind<[string,string]>('history:recover-code',recoverByCode);
  bind<[string]>('history:regenerate',regenerateHistory);
  bind<[string,string]>('history:open-pdf',async(recordId,pdfPath)=>{
    if(typeof recordId!=='string'||typeof pdfPath!=='string')throw new Error('Seleção inválida.');
    const record=await history.findById(account(),recordId);
    if(!record||!record.pdfPaths.includes(pdfPath)||!(await validateStoredPdf(pdfPath)))throw new Error('PDF não encontrado ou não pertence a este histórico.');
    const result=await shell.openPath(pdfPath);
    if(result)throw new Error('O leitor padrão do Windows não conseguiu abrir este PDF.');
  });
  bind('report:reprocess',reprocessLastResponse);
  bind('report:recovery-status',async()=>({hasResponse:queryRecovery.exists(),hasReport:lastReport!==null}));
  bind('report:open-pdf',async()=>{
    if(!lastSavedPdf||extname(lastSavedPdf).toLowerCase()!=='.pdf')throw new Error('Não há PDF gerado nesta sessão.');
    const pdfFile=lastSavedPdf;
    const info=await stat(pdfFile).catch(()=>{throw new Error('PDF não localizado no destino configurado.');});
    if(!info.isFile())throw new Error('Arquivo PDF inválido.');
    const result=await shell.openPath(pdfFile);
    if(result)throw new Error('O Windows não conseguiu abrir o PDF. Verifique o aplicativo leitor padrão.');
  });
  bind('report:open-folder',async()=>{
    const folder=(await getSettings()).outputFolder;
    if(!folder)throw new Error('Nenhuma pasta configurada.');
    const result=await shell.openPath(folder);
    if(result)throw new Error('Não foi possível abrir a pasta configurada.');
  });
  createMainWindow();
}).catch(e=>{void diagnostics?.write('startup_error',{errorType:toError(e).name}).catch(()=>{});console.error('Falha na inicialização:',toError(e).name);app.quit();});
// Antes de finalizar, aguarda as operações aceitas e libera o handle do SQLite.
// Não apaga nem recria o banco. A marca de migração e a chave permanecem no disco.
let shutdownRequested=false;
let shutdownReady=false;
app.on('before-quit',event=>{
  if(shutdownReady)return;
  event.preventDefault();
  if(shutdownRequested)return;
  shutdownRequested=true;
  monitor?.stopAll();
  void (async()=>{
    await Promise.allSettled([...activeCompletions]);
    await history?.close();
  })().catch(error=>{
    // Não registrar payloads, tokens ou identificadores nos diagnósticos.
    console.error('Falha ao encerrar o histórico SQLite:',toError(error).name);
  }).finally(()=>{
    shutdownReady=true;
    app.quit();
  });
});
app.on('window-all-closed',()=>{monitor?.stopAll();client.reset();sessionAccount=null;app.quit();});

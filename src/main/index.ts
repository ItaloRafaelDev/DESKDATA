import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, session, type IpcMainInvokeEvent } from 'electron';
import { stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { BackupService } from './backup.ts';
import { CpiBrowser } from './cpi/cpi-browser.ts';
import { CpiPendingMonitor } from './cpi/pending-monitor.ts';
import { inspectCpiPersonHistory } from './cpi/person-history.ts';
import { prepareCpiPersonPdf } from './cpi/person-recovery.ts';
import { assertCpiPaidBalance } from './cpi/paid-balance.ts';
import { validateCpiRowId } from './cpi/pending-rows.ts';
import { CpiWorkflowStore } from './cpi/workflow-store.ts';
import { reconcileCpiWorkflow } from './cpi/workflow-reconciliation.ts';
import { findCpiPersonPdf } from './cpi/person-pdf.ts';
import { CpiFullAutoRunner } from './cpi/full-auto-runner.ts';
import { executeCpiPersonCycle } from './cpi/full-cycle.ts';
import type { CpiPendingRowId, CpiPendingWorkflowStage } from '../shared/types.ts';
import { DiagnosticLogger } from './diagnostics.ts';
import { extname } from 'node:path';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const currentDir = dirname(fileURLToPath(import.meta.url));
import { cnpjDigits, isValidCnpj } from '../shared/cnpj.ts';
import { assertRecoveredCnpj } from '../shared/company-identity.ts';
import { normalizeCompanyResponse } from '../shared/company-report.ts';
import { isValidCpf, cpfDigits } from '../shared/cpf.ts';
import { assertRecoveredCpf } from '../shared/query-identity.ts';
import { PersonReportService, type ReceivedPersonQuery } from './person-reports.ts';
import type { QueryOutcome, QueryExecution, QueryUpdate, PisQueryExecution } from '../shared/types.ts';
import { DeskdataClient } from './deskdata-client.ts';
import { chooseFolder, getSettings } from './settings.ts';
import { saveCompanyReportPdf, saveReportPdf, savePisReportPdf } from './pdf.ts';
import { resolvePisOutcome } from './pis-outcome.ts';
import { CredentialStore } from './credentials.ts';
import { AccountApprovalStore } from './account-approval.ts';
import { QueryHistoryStore, assertQueryRecordIdentity, type QueryRecord } from './query-history.ts';
import { PendingQueryMonitor, type PendingTarget } from './pending-queries.ts';
import { MaintenanceService } from './maintenance.ts';
import { ApplicationOperations, settleWithin } from './operations.ts';
import type { MaintenanceSelection, MaintenanceResult } from '../shared/types.ts';

const client=new DeskdataClient();
const operations=new ApplicationOperations();
// A reserva acontece no wrapper IPC antes de invocar qualquer função assíncrona.
const exclusiveChannels=new Set([
  'api:query','pis:query','company:query','queries:resume','history:recover-code',
  'history:regenerate','pis:regenerate','company:regenerate','report:reprocess','report:save-again',
  'maintenance:clean','backup:create','auth:login','auth:logout','settings:choose-folder',
  'cpi:open','cpi:inspect','cpi:filter-person-29','cpi:rows:inspect','cpi:details:inspect',
  'cpi:person:history','cpi:person:prepare','cpi:workflow:verify','cpi:close'
]);
const cpiBrowser=new CpiBrowser();
const cpiMonitor=new CpiPendingMonitor(
  () => operations.run(()=>cpiBrowser.filterPendingPerson29(),true),
  snapshot => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('cpi:monitor:updated', snapshot);
    }
  }
);
let mainWindow:BrowserWindow;
let busy=false;
let lastSavedPdf:string|null=null;
let history:QueryHistoryStore;
let personReports:PersonReportService;
let monitor:PendingQueryMonitor;
let maintenance:MaintenanceService;
let backups:BackupService;
let diagnostics:DiagnosticLogger;
let maintenanceActive=false;
let sessionTransitionActive=false;
let approvals:AccountApprovalStore;
let cpiWorkflow:CpiWorkflowStore;
let cpiAuto:CpiFullAutoRunner;
const activeCompletions=new Set<Promise<void>>();
let sessionAccount:string|null=null;
let lastCompanyResponse:{cnpj:string;payload:unknown;queryCode?:string}|null=null;
let lastPisResponse:{cpf:string;payload:unknown;queryCode?:string}|null=null;

/** Processa no máximo um item por varredura. O navegador não altera várias pesquisas de uma vez. */
async function cpiScanOne():Promise<{found:number;outcomes:import('./cpi/full-cycle.ts').CpiCycleOutcome[]}>{
  const who=account();
  if(busy||maintenanceActive||sessionTransitionActive)throw new Error('Outra operação está em andamento.');
  busy=true;
  try {
    const settings=await getSettings();
    if(!settings.outputFolder)throw new Error('Configure uma pasta de PDFs antes da automação CPI.');
    let filtered: Awaited<ReturnType<CpiBrowser['filterPendingPerson29']>>;
    try { filtered=await cpiBrowser.filterPendingPerson29(); }
    catch { throw new Error('Etapa filtro CPI 29: falha ao atualizar a listagem.'); }
    if(filtered.state==='unconfirmed'||filtered.total===null)throw new Error('Etapa filtro CPI 29: total nao confirmado no portal.');
    if(filtered.total===0)return {found:0,outcomes:[]};
    let listed: Awaited<ReturnType<CpiBrowser['inspectPendingRows']>>;
    try { listed=await cpiBrowser.inspectPendingRows(); }
    catch { throw new Error('Etapa leitura CPI: nao foi possivel inspecionar as linhas apos o filtro.'); }
    if(listed.state!=='mapped'||!listed.rows.length)throw new Error('Etapa leitura CPI: identificadores da listagem nao confirmados.');
    // Revalidar o CPF dentro do processo principal; o renderer nunca recebe seus dígitos.
    let ids:import('./cpi/pending-rows.ts').CpiPendingRowId|undefined;
    for(const candidate of listed.rows){
      const existing=await cpiWorkflow.get(who,candidate);
      if(existing?.stage==='completed')continue;
      ids=candidate;
      break;
    }
    if(!ids)return {found:filtered.total,outcomes:[]};
    const target=ids;
    const result=await executeCpiPersonCycle({
      account:who,ids:target,outputFolder:settings.outputFolder,
      getCpf:async()=>{await cpiBrowser.inspectPendingPersonDetails(target);return cpiBrowser.readValidatedCpf(target);},
      getJob:()=>cpiWorkflow.get(who,target),
      claim:()=>cpiWorkflow.claim(who,target),
      mark:(stage,updates)=>cpiWorkflow.mark(who,target,stage,updates),
      findLatest:cpf=>history.findLatest(who,cpf,'person'),
      beginHistory:cpf=>history.begin(who,cpf,'person'),
      setQueryCode:(recordId,code)=>history.setCode(recordId,code),
      getCredits:()=>client.credits(),
      verifyPaidBalance:async credits=>{assertCpiPaidBalance(credits,await approvals.isApproved(who));},
      paidApproved:()=>approvals.isApproved(who),
      submitCpf:(cpf,onCode)=>client.submitCpf(cpf,onCode),
      fetchByCode:code=>client.fetchByCode(code),
      savePdf:async(cpf,recordId,code,data)=>{
        const identity={account:who,kind:'person' as const,document:cpf,queryCode:code};
        const record=await history.findById(who,recordId);
        if(!record)throw new Error('Registro CPI indisponível no histórico desta conta.');
        assertQueryRecordIdentity(record,identity);
        const outcome=await saveReportPdf(settings.outputFolder!,{cpf,consultedAt:new Date().toISOString(),queryCode:code,data});
        await history.addPdf(recordId,outcome.path,identity);
        showHistoryChange({kind:'person',recordId,state:'ready'});
      },
      uploadAndSave:async(pdf,result)=>{
        if(sessionAccount!==who)throw new Error('Conta Deskdata alterada durante o processamento CPI.');
        return cpiBrowser.uploadAndSavePersonResponse(target,pdf,result);
      },
      closeCompletedDetail:()=>cpiBrowser.closeCompletedDetail(target)
    });
    if(sessionAccount!==who)throw new Error('Conta Deskdata alterada durante o processamento CPI.');
    return {found:filtered.total,outcomes:[result]};
  }finally{busy=false;}
}

function guard(event:IpcMainInvokeEvent):void {
  if(!mainWindow || event.sender.id!==mainWindow.webContents.id || event.senderFrame!==mainWindow.webContents.mainFrame)throw new Error('Origem IPC não autorizada.');
}
function bind<T extends unknown[]>(channel:string,operation:(...args:T)=>Promise<unknown>):void{
  ipcMain.handle(channel,async(event,...args:unknown[])=>{
    guard(event);
    const began=performance.now();
    try {
      if(channel==='cpi:close'||channel==='auth:logout'){
        operations.assertAccepting();
        await cpiAuto.pause();
      }
      const result=await operations.run(()=>operation(...(args as T)),exclusiveChannels.has(channel));
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
async function processReceived(received:ReceivedPersonQuery):Promise<QueryOutcome>{
  const result=await personReports.processReceived(received);
  lastSavedPdf=result.path;
  return result;
}
async function reprocessLastResponse(): Promise<QueryOutcome> {
  if (busy) throw new Error('Já existe uma operação em execução.');
  busy = true;
  try {
    const result=await personReports.reprocessLastResponse();
    lastSavedPdf=result.path;
    return result;
  } finally { busy = false; }
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
    if(!shutdownRequested)monitor.watch(targetFrom(record),immediate);
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
  const result:ReceivedPersonQuery={account:record.account,recordId:record.id,cpf:record.cpf,consultedAt:new Date().toISOString(),queryCode:record.queryCode,payload:received.payload};
  return ready({...await processReceived(result),reused:true});
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
    const received:ReceivedPersonQuery={account:target.account,recordId:target.id,cpf:target.cpf,consultedAt:new Date().toISOString(),queryCode:target.queryCode,payload};
    await processReceived(received);
  }
  showHistoryChange({kind:target.kind,recordId:target.id,state:'ready'});
  })();
  activeCompletions.add(work);
  try{await work;}finally{activeCompletions.delete(work);}
}
async function resumeAfterAuthentication(who:string):Promise<void>{
  for(const kind of ['person','company'] as const){
    for(const row of await history.list(who,kind)){
      if(!shutdownRequested && row.status==='pending' && row.queryCode)monitor.watch(targetFrom(row),true);
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
  if(cpiAuto?.isActive())throw new Error('Pause o ciclo CPI FULL AUTO antes de consultar manualmente.');
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
        personReports.clearReport();lastSavedPdf=validPaths[0];
        return ready({path:validPaths[0],savedAt:previous.updatedAt,queryCode:previous.queryCode,recordId:previous.id,reused:true});
      }
      if(!previous.queryCode){
        const cached=personReports.readFor(who,cpf,previous.id);
        if(cached)return ready(await processReceived(cached));
        throw new Error('Existe uma consulta anterior deste CPF sem PDF disponível nem código recuperável. Nenhum novo POST foi enviado. Verifique o histórico antes de autorizar outra consulta.');
      }
      return resolveRecorded(previous);
    }
    await assertPaidQueryApproved();
    const credits=await client.credits();
    if(credits<=0)throw new Error('Saldo de créditos indisponível ou zerado.');
    // Registro cifrado ANTES do POST. Se a conexão cair, não repetimos uma operação potencialmente cobrada.
    const record=await history.begin(who,cpf);
    const outcome=await client.submitCpf(cpf,code=>history.setCode(record.id,code));
    if(outcome.state==='pending')return pending({...record,queryCode:outcome.queryCode});
    const received:ReceivedPersonQuery={account:who,recordId:record.id,cpf,consultedAt:new Date().toISOString(),queryCode:outcome.queryCode,payload:outcome.payload};
    return ready(await processReceived(received));
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
  if(cpiAuto?.isActive())throw new Error('Pause o ciclo CPI FULL AUTO antes de consultar manualmente.');
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
  if(cpiAuto?.isActive())throw new Error('Pause o ciclo CPI FULL AUTO antes de consultar manualmente.');
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
  busy=true;
  try{
    const result=await personReports.saveAgain();
    lastSavedPdf=result.path;
    return result;
  }finally{busy=false;}
}
function createMainWindow():void{
  mainWindow=new BrowserWindow({
    width:1180,height:780,minWidth:880,minHeight:640,show:false,autoHideMenuBar:true,backgroundColor:'#f4f7fb',title:'DESKDATA',
    webPreferences:{preload:join(currentDir,'../preload/index.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true}
  });
  mainWindow.once('ready-to-show',()=>mainWindow.show());
  mainWindow.on('close',event=>{
    if(!shutdownReady){event.preventDefault();app.quit();}
  });
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
  personReports = new PersonReportService({history,
    currentAccount:()=>sessionTransitionActive?null:sessionAccount,
    getOutputFolder:async()=>(await getSettings()).outputFolder,
    savePdf:saveReportPdf});
  approvals = new AccountApprovalStore(dataDir,protector);
  cpiWorkflow = new CpiWorkflowStore(dataDir,protector);
  cpiAuto = new CpiFullAutoRunner(()=>operations.run(cpiScanOne,true),snapshot=>{
    if(mainWindow&&!mainWindow.isDestroyed()&&!mainWindow.webContents.isDestroyed())
      mainWindow.webContents.send('cpi:auto:updated',snapshot);
  });
  maintenance = new MaintenanceService(history);
  backups=new BackupService({userData:dataDir,backupDirectory:app.isPackaged?join(dataDir,'backups'):join(app.getAppPath(),'backups'),history,protector,getSettings});
  monitor = new PendingQueryMonitor({
    get:code=>operations.run(()=>client.checkByCode(code)),
    complete:(target,payload)=>operations.run(()=>completePending(target,payload)),
    pause:(target,message)=>operations.run(async()=>{
      if(sessionAccount!==target.account)return;
      await history.setPaused(target.id,message);
      showHistoryChange({kind:target.kind,recordId:target.id,state:'paused',message});
    })
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
    if(busy||maintenanceActive||sessionTransitionActive||cpiAuto.isActive())throw new Error('Pause a automação CPI antes de criar o backup.');
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
    if(cpiAuto.isActive()||cpiMonitor.isActive())throw new Error('Pause a automação CPI antes de executar a limpeza.');
    if(!selection||typeof selection.pdfs!=='boolean'||typeof selection.history!=='boolean'||(!selection.pdfs&&!selection.history))throw new Error('Selecione os dados a limpar.');
    maintenanceActive=true;
    busy=true;
    monitor.stopAll();
    try{
      // Concluir recuperações aceitas antes de apresentar o resumo ou excluir arquivos.
      await Promise.allSettled([...activeCompletions]);
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
      operations.assertAccepting();
      account();
      if(cpiAuto.isActive()||cpiMonitor.isActive())throw new Error('Pause a automação CPI antes de executar a limpeza.');
      if(answer.response!==1)return {cancelled:true,deletedPdfs:0,missingPdfs:0,deletedRecords:0};
      const result=await maintenance.clean(selection);
      personReports.clear();lastSavedPdf=null;
      lastCompanyResponse=null;lastPisResponse=null;
      return {...result,cancelled:false};
    }finally{
      maintenanceActive=false;busy=false;
      if(!shutdownRequested && sessionAccount)await resumeAfterAuthentication(sessionAccount);
    }
  });
  bind('cpi:history:list',async()=>{
    const who=account();
    const items=await cpiWorkflow.list(who);
    const completed=items.filter(item=>item.stage==='completed');
    const reviewCount=items.filter(item=>['verification_required','review_required','submit_started'].includes(item.stage)).length;
    const recent=await Promise.all(completed.slice(0,100).map(async item=>{
      let pdfAvailable=false;
      if(item.historyRecordId){
        const record=await history.findById(who,item.historyRecordId);
        if(record && (record.kind==='person'||record.kind===undefined) && record.account===who){
          for(const path of record.pdfPaths){
            if(await validateStoredPdf(path)){pdfAvailable=true;break;}
          }
        }
      }
      return {pesquisaId:item.pesquisaId,solicitacaoId:item.solicitacaoId,
        classification:item.classification??'information',answeredAt:item.updatedAt,pdfAvailable};
    }));
    return {completedCount:completed.length,reviewCount,items:recent};
  });
  bind<[number,number]>('cpi:workflow:pending',async(page,pageSize)=>{
    const who=account();
    const result=await cpiWorkflow.listPending(who,page,pageSize);
    return {...result,items:result.items.map(item=>{
      const last=item.verificationEvents?.at(-1);
      return {pesquisaId:item.pesquisaId,solicitacaoId:item.solicitacaoId,
        stage:item.stage as CpiPendingWorkflowStage,reviewReason:item.reviewReason,
        lastVerificationReason:last?.reason,createdAt:item.createdAt,submittedAt:item.submittedAt,
        updatedAt:item.updatedAt,lastCheckedAt:last?.at};
    })};
  });
  bind<[CpiPendingRowId]>('cpi:workflow:verify',async ids=>{
    const who=account();
    if(!validateCpiRowId(ids))throw new Error('Identificadores CPI inválidos.');
    if(cpiAuto.isActive()||cpiMonitor.isActive()||busy||maintenanceActive)
      throw new Error('Pause o agente e o monitor CPI antes de verificar uma pesquisa.');
    const result=await reconcileCpiWorkflow({store:cpiWorkflow,account:who,ids,
      checkLocal:async job=>{
        if(!job.historyRecordId)return {ready:false};
        const record=await history.findById(who,job.historyRecordId);
        if(!record||record.account!==who||(record.kind!==undefined&&record.kind!=='person')||record.status!=='ready'||!isValidCpf(record.cpf))return {ready:false};
        const folder=(await getSettings()).outputFolder;
        if(!folder)return {ready:false};
        try{await findCpiPersonPdf(record,record.cpf,folder);return {ready:true,cpf:record.cpf};}
        catch{return {ready:false};}
      },
      inspectRemote:(target,classification,cpf)=>cpiBrowser.inspectPersistedPersonResponse(target,classification,cpf)
    });
    if(sessionAccount!==who)throw new Error('Conta alterada durante a verificação CPI.');
    const last=result.verificationEvents?.at(-1);
    if(!last)throw new Error('Auditoria da verificação CPI indisponível.');
    return {stage:result.stage,reason:last.reason,checkedAt:last.at};
  });
  bind<[CpiPendingRowId]>('cpi:history:open-pdf',async ids=>{
    const who=account();
    if(!validateCpiRowId(ids))throw new Error('Identificador de solicitação inválido.');
    const job=await cpiWorkflow.get(who,ids);
    if(job?.stage!=='completed'||!job.historyRecordId)throw new Error('Pesquisa não concluída ou sem relatório vinculado.');
    const record=await history.findById(who,job.historyRecordId);
    if(!record||(record.kind!==undefined&&record.kind!=='person')||record.account!==who)throw new Error('Relatório não pertence à conta autenticada.');
    for(const path of record.pdfPaths){
      if(await validateStoredPdf(path)){
        const error=await shell.openPath(path);
        if(error)throw new Error('Não foi possível abrir o PDF no leitor padrão.');
        return;
      }
    }
    throw new Error('PDF vinculado indisponível ou inválido.');
  });
  bind('cpi:auto:status',async()=>{account();return cpiAuto.status();});
  bind<[number]>('cpi:auto:start',async seconds=>{
    account();
    if(cpiMonitor.isActive()||busy||maintenanceActive||operations.isExclusive())throw new Error('Pause o monitor e conclua a operação atual antes de iniciar FULL AUTO.');
    if(cpiBrowser.status().state!=='open')throw new Error('Autentique-se na CPI pelo Edge antes de iniciar.');
    if(!await approvals.isApproved(account()))throw new Error('Autorize consultas Deskdata para a conta em Minha conta.');
    operations.assertAccepting();
    account();
    if(cpiMonitor.isActive()||busy||maintenanceActive||operations.isExclusive())throw new Error('Conclua a operação atual antes de iniciar FULL AUTO.');
    return cpiAuto.start(seconds);
  });
  bind('cpi:auto:pause',async()=>{account();return cpiAuto.pause();});
  bind('cpi:open',async()=>{account();return cpiBrowser.open();});
  bind('cpi:status',async()=>{account();return cpiBrowser.status();});
  bind('cpi:inspect',async()=>{account();if(cpiMonitor.isActive()||cpiAuto.isActive())throw new Error('Pause o monitor antes de inspecionar o DOM.');return cpiBrowser.inspectControls();});
  bind('cpi:filter-person-29',async()=>{account();if(cpiMonitor.isActive()||cpiAuto.isActive())throw new Error('Pause o monitor antes de aplicar o filtro manualmente.');return cpiBrowser.filterPendingPerson29();});
  bind('cpi:rows:inspect',async()=>{account();if(cpiMonitor.isActive()||cpiAuto.isActive())throw new Error('Pause o monitor antes de inspecionar as linhas.');return cpiBrowser.inspectPendingRows();});
  bind<[CpiPendingRowId]>('cpi:details:inspect',async(ids)=>{account();if(cpiMonitor.isActive()||cpiAuto.isActive())throw new Error('Pause o monitor antes de abrir os detalhes.');if(!validateCpiRowId(ids))throw new Error('Identificadores CPI inválidos.');return cpiBrowser.inspectPendingPersonDetails(ids);});
  bind<[CpiPendingRowId]>('cpi:person:history',async(ids)=>{
    const accountId = account();
    if(cpiMonitor.isActive() || cpiAuto.isActive() || busy || maintenanceActive)throw new Error('Pause o monitoramento e conclua as operações atuais.');
    if(!validateCpiRowId(ids))throw new Error('Identificadores CPI inválidos.');
    // Revalida o detalhe ativo antes de usar o CPF somente no processo principal.
    await cpiBrowser.inspectPendingPersonDetails(ids);
    const cpf = cpiBrowser.readValidatedCpf(ids);
    const {outputFolder}=await getSettings();
    const result = await inspectCpiPersonHistory({
      account:accountId,cpf,pesquisaId:ids.pesquisaId,solicitacaoId:ids.solicitacaoId,
      outputFolder,findLatest:(currentAccount,currentCpf,kind)=>history.findLatest(currentAccount,currentCpf,kind)
    });
    if(sessionAccount!==accountId)throw new Error('Sessão alterada durante a leitura do histórico.');
    return result;
  });
  bind<[CpiPendingRowId]>('cpi:person:prepare',async(ids)=>{
    const accountId=account();
    if(cpiMonitor.isActive() || cpiAuto.isActive() || busy || maintenanceActive)throw new Error('Pause o monitoramento e conclua as operacoes atuais.');
    if(!validateCpiRowId(ids))throw new Error('Identificadores CPI invalidos.');
    // Bloqueio de concorrencia abrange leitura de CPF, historico e GET opcional.
    busy=true;
    try {
      await cpiBrowser.inspectPendingPersonDetails(ids);
      const cpf=cpiBrowser.readValidatedCpf(ids);
      const {outputFolder}=await getSettings();
      const prepared=await prepareCpiPersonPdf({
        ids,account:accountId,cpf,outputFolder,
        findLatest:(who,document,kind)=>history.findLatest(who,document,kind),
        recoverExisting:async record=>{
          // resolveRecorded executa somente GET de codigo ja registrado.
          const recovered=await resolveRecorded(record);
          return {state:recovered.state};
        }
      });
      if(sessionAccount!==accountId)throw new Error('Sessao Deskdata alterada durante a preparacao.');
      return prepared;
    } finally { busy=false; }
  });
  bind<[number]>('cpi:monitor:start',async(intervalSeconds)=>{account();if(operations.isExclusive())throw new Error('Conclua a operação atual antes de iniciar o monitor.');if(cpiAuto.isActive())throw new Error('Pause o ciclo FULL AUTO primeiro.');if(cpiBrowser.status().state!=='open')throw new Error('Abra o Edge e autentique na CPI antes de iniciar o monitor.');return cpiMonitor.start(intervalSeconds);});
  bind('cpi:monitor:pause',async()=>{account();return cpiMonitor.pause();});
  bind('cpi:monitor:status',async()=>{account();return cpiMonitor.status();});
  bind('cpi:close',async()=>{account();await cpiAuto.pause();await cpiMonitor.stopAndWait();await cpiBrowser.close();});
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
      await cpiAuto.pause();
      await cpiMonitor.stopAndWait();
      await cpiBrowser.close();
      client.reset();sessionAccount=null;lastCompanyResponse=null;lastSavedPdf=null;lastPisResponse=null;personReports.clear();
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
  bind('report:recovery-status',async()=>personReports.status());
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
  operations.stopAccepting();
  monitor?.stopAll();
  // Interromper novos agendamentos agora, preservando o ciclo e a sessão em curso.
  const stopping=[cpiAuto?.pause(),cpiMonitor.stopAndWait()];
  const started=performance.now();
  let databaseCloseStarted=false;
  void (async()=>{
    if(!await operations.waitForIdle(stopping))throw new Error('ShutdownTimeoutError');
    await Promise.allSettled([...activeCompletions]);
    if(!await settleWithin(cpiBrowser.close(),60_000-(performance.now()-started)))throw new Error('ShutdownTimeoutError');
    databaseCloseStarted=true;
    await history?.close();
    client.reset();sessionAccount=null;personReports?.clear();
    shutdownReady=true;
    app.quit();
  })().catch(error=>{
    // Não registrar payloads, tokens ou identificadores nos diagnósticos.
    console.error('Falha ao encerrar o histórico SQLite:',toError(error).name);
    shutdownRequested=false;
    if(!databaseCloseStarted)operations.resumeAccepting();
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

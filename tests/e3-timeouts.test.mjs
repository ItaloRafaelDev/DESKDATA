import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CancelledError, cancellableDelay, isDeadlineError, runWithDeadline, withDeadline } from '../src/main/deadline.ts';
import { DeskdataClient } from '../src/main/deskdata-client.ts';
import { renderAndSave } from '../src/main/pdf-render.ts';
import { findCpiPersonPdf } from '../src/main/cpi/person-pdf.ts';
import { DialogGuard } from '../src/main/dialog-guard.ts';
import { CpiBrowser, CPI_OPERATION_TIMEOUTS } from '../src/main/cpi/cpi-browser.ts';
import { CpiPendingMonitor } from '../src/main/cpi/pending-monitor.ts';
import { CPI_PENDING_URL } from '../src/main/cpi/pending-filter.ts';
import { classifyCpiError } from '../src/main/cpi/failure-classes.ts';
import { realPortalFixture, ids } from './helpers/cpi-portal-real.mjs';
import { withMainProcess } from './helpers/main-process.mjs';

// E3: para cada classe de espera, um fake que nunca resolve precisa gerar erro classificado dentro do prazo
// esperado, sem repetir efeito externo. Nenhum teste chama Deskdata ou CPI reais.
const hang=()=>new Promise(()=>{});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
async function within(ms,work){
  const started=Date.now();
  const result=await work();
  const elapsed=Date.now()-started;
  assert.ok(elapsed<ms,`levou ${elapsed} ms (limite do teste ${ms} ms)`);
  return result;
}
async function until(check,ms=3000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await wait(10);}throw new Error('Condição de teste não atingida');}

// ---------- utilitário de prazo ----------
test('E3: withDeadline rejeita com TimeoutError (classe timeout) e chama onTimeout antes',async()=>{
  let aborted=false;
  const error=await within(1000,()=>withDeadline(hang(),30,'etapa_teste',()=>{aborted=true;}).catch(e=>e));
  assert.equal(isDeadlineError(error),true);assert.equal(aborted,true);
  assert.match(error.message,/Tempo limite excedido \(etapa_teste/);
  assert.equal(classifyCpiError(error),'timeout');
});
test('E3: runWithDeadline aborta o sinal do corpo no prazo e cancela na hora quando o pai aborta',async()=>{
  let seen;
  await assert.rejects(within(1000,()=>runWithDeadline('etapa',30,signal=>{seen=signal;return hang();})),e=>isDeadlineError(e));
  assert.equal(seen.aborted,true);
  const parent=new AbortController();
  const running=runWithDeadline('etapa',60_000,signal=>{seen=signal;return hang();},parent.signal);
  parent.abort();
  const error=await within(500,()=>running.catch(e=>e));
  assert.ok(error instanceof CancelledError);assert.equal(seen.aborted,true);
  assert.equal(classifyCpiError(error),'cpi_session');
});
test('E3: cancellableDelay termina imediatamente quando o sinal aborta',async()=>{
  const controller=new AbortController();
  const delay=cancellableDelay(60_000,controller.signal);controller.abort();
  await within(500,()=>delay);
});

// ---------- Deskdata (W1–W4, L7) ----------
const auth=()=>new Response(JSON.stringify({status:{code:2000},data:{access_token:'test-token',expires_at:new Date(Date.now()+3600000).toISOString()}}),{status:200});
const pendingGet=()=>new Response(JSON.stringify({status:{code:4008},data:{}}),{status:202});
async function authenticated(fetcher,sleep,options){
  const client=new DeskdataClient(async(url,init)=>url.endsWith('/auth')?auth():fetcher(url,init),sleep,options);
  await client.authenticate('dev@example.org','secret');return client;
}
test('E3/W1: POST sem resposta (transporte ignora o AbortSignal) falha no prazo, classificado, sem segundo POST',async()=>{
  let posts=0;
  const client=await authenticated(async(_url,init)=>{if(init.method==='POST')posts++;return hang();},undefined,{timeoutMs:40});
  const error=await within(3000,()=>client.submitCpf('52998224725').catch(e=>e));
  assert.match(error.message,/Tempo limite de resposta\. Não repita automaticamente/);
  assert.equal(classifyCpiError(error),'timeout');
  await wait(100);assert.equal(posts,1);
});
test('E3/W1: POST que respeita o AbortSignal é abortado no prazo por requisição',async()=>{
  let posts=0;
  const client=await authenticated((_url,init)=>{if(init.method==='POST')posts++;
    return new Promise((_r,reject)=>init.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'}))));},undefined,{timeoutMs:40});
  const error=await within(800,()=>client.submitCpf('52998224725').catch(e=>e));
  assert.match(error.message,/Tempo limite de resposta/);assert.equal(posts,1);
});
test('E3/W1: logout (reset) durante o POST encerra a espera na hora, sem repetir, como sessão Deskdata',async()=>{
  let posts=0;const started=deferred();
  const client=await authenticated((_url,init)=>{if(init.method==='POST'){posts++;started.resolve();}
    return new Promise((_r,reject)=>init.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'}))));});
  const query=client.submitCpf('52998224725').catch(e=>e);
  await started.promise;client.reset();
  const error=await within(500,()=>query);
  assert.match(error.message,/Sessão Deskdata encerrada durante a requisição\. Não repita automaticamente/);
  assert.equal(classifyCpiError(error),'deskdata_session');
  await wait(50);assert.equal(posts,1);
});
test('E3/W2/W3: polling por código respeita o prazo total, só faz GET e mantém o código recuperável',async()=>{
  let clock=0;const methods=[];
  const client=await authenticated(async(_url,init)=>{methods.push(init.method);return pendingGet();},
    async ms=>{clock+=ms;},{pollDeadlineMs:20_000,now:()=>clock});
  const error=await client.fetchByCode('Q-ABC123DEF4').catch(e=>e);
  assert.match(error.message,/ainda em processamento \(Q-ABC123DEF4\)\. Recupere-a posteriormente sem criar nova consulta/);
  assert.equal(methods.includes('POST'),false);
  assert.equal(methods.length,5,'1 GET inicial + 4 tentativas dentro de 20 s');
});
test('E3/W2: logout durante a espera do polling cancela a espera imediatamente, sem novo GET',async()=>{
  const methods=[];const firstGet=deferred();
  const client=await authenticated(async(_url,init)=>{methods.push(init.method);firstGet.resolve();return pendingGet();});
  const fetching=client.fetchByCode('Q-ABC123DEF4').catch(e=>e);
  await firstGet.promise;await wait(20);client.reset();
  const error=await within(500,()=>fetching);
  assert.match(error.message,/Sessão Deskdata encerrada/);
  assert.deepEqual(methods,['GET']);
});
test('E3/W4: consulta PIS (POST + polling) sem resposta no GET falha no prazo sem novo POST',async()=>{
  let posts=0;
  const client=await authenticated(async(_url,init)=>{
    if(init.method==='POST'){posts++;return new Response(JSON.stringify({status:{code:4008},query_code:'Q-ABC123DEF4',data:{}}),{status:202});}
    return hang();
  },async()=>{},{timeoutMs:40});
  const error=await within(3000,()=>client.queryBasicCpf('52998224725').catch(e=>e));
  assert.match(error.message,/Tempo limite de resposta/);assert.equal(posts,1);
});

// ---------- disco do PDF (W6) ----------
const fakeWindow=()=>({isDestroyed:()=>false,destroy:()=>{},loadURL:async()=>{},
  webContents:{executeJavaScript:async()=>true,printToPDF:async()=>Buffer.from('%PDF-1.7\nteste')}});
test('E3/W6: pasta de destino que não responde (stat ou writeFile) falha no prazo e o caminho não é registrado',async()=>{
  for(const fs of [{stat:hang,writeFile:hang},{stat:async()=>({isDirectory:()=>true}),writeFile:hang}]){
    const error=await within(1000,()=>renderAndSave(fakeWindow,'C:\\pasta-ficticia','<html><head></head><body></body></html>','RELATORIO_X',undefined,1000,{timeoutMs:40,fs}).catch(e=>e));
    assert.match(error.message,/pasta de destino não respondeu.*não foi registrado/);
    assert.equal(classifyCpiError(error),'timeout');
  }
});
test('E3/W6: conferência do PDF para anexo com pasta que não responde falha no prazo sem anexar',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'deskdata-e3-pdf-')));
  try{
    const record={id:'1',kind:'person',account:'a@example.com',cpf:'52998224725',requestedAt:'2026-11-12',updatedAt:'2026-11-12',status:'ready',
      pdfPaths:[join(root,'CPI_537987_275064_2026-11-12.pdf')]};
    const error=await within(1000,()=>findCpiPersonPdf(record,'52998224725',root,ids,40,{realpath:hang,stat:hang,open:hang}).catch(e=>e));
    assert.match(error.message,/não respondeu a tempo\. Nenhum anexo será enviado/);
    assert.equal(classifyCpiError(error),'timeout');
  }finally{await rm(root,{recursive:true,force:true});}
});

// ---------- diálogos (W24, W25) ----------
test('E3/W24: confirmação sem resposta fecha no prazo e vale cancelar; encerramento também cancela',async()=>{
  const guard=new DialogGuard(40);let signal;
  assert.equal(await within(1000,()=>guard.confirm(s=>{signal=s;return hang();},1)),false);
  assert.equal(signal.aborted,true,'o sinal fecha o diálogo nativo');
  const shutdown=new DialogGuard(60_000);
  const open=shutdown.confirm(s=>{signal=s;return hang();},1);
  shutdown.cancelAll();
  assert.equal(await within(500,()=>open),false);assert.equal(signal.aborted,true);
  assert.equal(await guard.confirm(async()=>({response:1}),1),true);
  assert.equal(await guard.confirm(async()=>({response:0}),1),false);
});
test('E3/W25: espera de diálogo sem cancelamento nativo termina no encerramento e descarta o resultado',async()=>{
  const guard=new DialogGuard();
  const picking=guard.untilShutdown(hang());guard.cancelAll();
  assert.equal(await within(500,()=>picking),null);
  assert.equal(await guard.untilShutdown(Promise.resolve('C:\\pasta')),'C:\\pasta');
});
test('E3/W24: limpeza com diálogo sem resposta é cancelada no prazo sem excluir dados',()=>{
  const cleaned=[];let received;
  return withMainProcess(async()=>{throw new Error('sem consulta');},async({invoke})=>{
    const result=await within(3000,()=>invoke('maintenance:clean',{pdfs:true,history:true}));
    assert.equal(result.cancelled,true);assert.deepEqual(cleaned,[]);
    assert.equal(received?.aborted,true);
  },{dialogTimeoutMs:40,maintenance:selection=>{cleaned.push(selection);return {deletedPdfs:0,missingPdfs:0,deletedRecords:0};},
    showMessageBox:(_window,options)=>{received=options.signal;return hang();}});
});
test('E3/W25: seleção de pasta não prende o bloqueio exclusivo nem o encerramento, e nada é gravado',()=>{
  const opened=deferred();
  return withMainProcess(async()=>{throw new Error('sem consulta');},async({invoke,requestQuit,hasQuit,events})=>{
    const picking=invoke('settings:choose-folder').then(()=>null,error=>error);
    await opened.promise;
    await assert.rejects(invoke('settings:choose-folder'),/já está aberta/);
    // Operação exclusiva concorrente continua possível com o diálogo aberto.
    assert.equal((await invoke('cpi:filter-person-29')).typeId,'29');
    requestQuit();
    await until(hasQuit);
    assert.match((await picking)?.message??'',/encerramento/);
    assert.equal(events.includes('settings_saved'),false);
    // E5: `cpi:filter-person-29` é canal de inspeção, registrado só fora do app instalado.
  },{pickOutputFolder:()=>{opened.resolve();return hang();},cpiOpen:true,isPackaged:false});
});

// ---------- navegador CPI (W8–W23, L8, C9) com página falsa ----------
const CPI_HOST_URL='https://adm.cpicentral.com.br/';
function fakePage({isVisible=hang,evaluate=hang,bringToFront=hang}={}){
  const clicks=[];
  const locator=()=>{const l={first:()=>l,nth:()=>l,isVisible,count:async()=>1,click:async()=>{clicks.push('click');},
    evaluate:async()=>{clicks.push('evaluate');},getAttribute:async()=>'29',isChecked:async()=>false,innerText:hang,waitFor:hang,evaluateAll:hang,elementHandle:hang};return l;};
  const frame={url:()=>CPI_HOST_URL,locator,evaluate};
  const page={url:()=>CPI_PENDING_URL,frames:()=>[frame],locator,isClosed:()=>false,bringToFront,waitForTimeout:wait,goto:hang,on(){},off(){}};
  return {page,frame,clicks};
}
function driverWith(page,timeouts){
  const driver=new CpiBrowser(timeouts);
  driver.browser={isConnected:()=>true,close:hang,on(){}};driver.page=page;
  return driver;
}
test('E3: prazos padrão da CPI cobrem os limites internos de cada operação',()=>{
  assert.ok(CPI_OPERATION_TIMEOUTS.filter>=12_000+15_000+25_000+30_000);
  assert.ok(CPI_OPERATION_TIMEOUTS.closeDetail>=4_000+7_000+8_000+8_000+10_000+20_000);
  assert.ok(CPI_OPERATION_TIMEOUTS.save>=12_000+12_000+10_000+10_000);
});
test('E3/W20/W21: filtro 29 com frame que não responde falha no prazo e o corpo tardio não clica',async()=>{
  const gate=deferred();
  const {page,clicks}=fakePage({isVisible:()=>gate.promise});
  const driver=driverWith(page,{filter:60});
  const error=await within(1000,()=>driver.filterPendingPerson29().catch(e=>e));
  assert.equal(classifyCpiError(error),'timeout');
  gate.resolve(true);await wait(50);
  assert.deepEqual(clicks,[],'nenhum clique depois do prazo');
  await assert.rejects(driver.inspectPendingRows(),/filtro 29 deve ser executado novamente/);
});
test('E3/W22/L8: leitura das linhas com evaluate sem resposta falha no prazo sem mapear linhas',async()=>{
  const {page}=fakePage();
  const driver=driverWith(page,{rows:60});
  driver.lastFilter={result:{typeId:'29',total:2,state:'found'},pageUrl:page.url(),checkedAt:Date.now()};
  const error=await within(1000,()=>driver.inspectPendingRows().catch(e=>e));
  assert.equal(classifyCpiError(error),'timeout');
  assert.deepEqual(driver.lastMappedRows,[]);
});
test('E3/W11/W12: abrir detalhe sem resposta falha no prazo, etapa registrada como falha e CPF não retido',async()=>{
  const {page}=fakePage();
  const driver=driverWith(page,{detail:60});driver.lastMappedRows=[ids];
  const steps=[];const timer={begin:step=>{let done=false;return state=>{if(!done){done=true;steps.push(`${step}:${state}`);}};}};
  const error=await within(1000,()=>driver.inspectPendingPersonDetails(ids,timer).catch(e=>e));
  assert.equal(classifyCpiError(error),'timeout');
  assert.deepEqual(steps,['cpi_open_detail:failed']);
  assert.throws(()=>driver.readValidatedCpf(ids),/Abra e valide/);
});
test('E3/W18/W19: fechar detalhe sem resposta falha no prazo (o ciclo vai para revisão; nada é reenviado)',async()=>{
  const {page,clicks}=fakePage();
  const driver=driverWith(page,{closeDetail:60});driver.lastConfirmedSave={...ids,frame:{}};
  const error=await within(1000,()=>driver.closeCompletedDetail(ids).catch(e=>e));
  assert.equal(classifyCpiError(error),'timeout');assert.deepEqual(clicks,[]);
});
test('E3: reconciliação sem resposta vira indisponível no prazo (nunca confirmação)',async()=>{
  const {page}=fakePage();
  const driver=driverWith(page,{reconcile:60});
  assert.equal(await within(1000,()=>driver.inspectPersistedPersonResponse(ids,'information','52998224725')),'unavailable');
});
test('E3/W9/W10: focar e fechar o navegador sem resposta respeitam o prazo; fechar libera a sessão',async()=>{
  const {page}=fakePage();
  const driver=driverWith(page,{focus:50,close:50});
  const error=await within(1000,()=>driver.open().catch(e=>e));
  assert.equal(classifyCpiError(error),'timeout');
  await within(1000,()=>driver.close());
  assert.equal(driver.status().state,'closed');
});
test('E3/W8: abertura sem resposta falha no prazo e libera a reabertura',async()=>{
  const driver=new CpiBrowser({open:60});let seen;
  driver.launch=signal=>{seen=signal;return hang();};
  const error=await within(1000,()=>driver.open().catch(e=>e));
  assert.equal(classifyCpiError(error),'timeout');assert.equal(seen.aborted,true);
  assert.equal(driver.opening,null);
});
test('E3: fechar o navegador cancela a operação CPI em curso na hora',async()=>{
  const {page}=fakePage();
  const driver=driverWith(page,{filter:60_000,close:50});
  const filtering=driver.filterPendingPerson29().catch(e=>e);
  await wait(20);await driver.close();
  const error=await within(500,()=>filtering);
  assert.equal(error.name,'AbortError');assert.equal(classifyCpiError(error),'cpi_session');
});
test('E3/C9: parar o monitor com leitura do filtro presa termina no prazo do filtro',async()=>{
  const {page}=fakePage();
  const driver=driverWith(page,{filter:80});
  const monitor=new CpiPendingMonitor(()=>driver.filterPendingPerson29());
  monitor.start(60);
  await until(()=>monitor.status().phase==='checking');await wait(10);
  await within(1000,()=>monitor.stopAndWait());
  assert.equal(monitor.isActive(),false);
});

// ---------- salvar na CPI (W13–W16): portal simulado em Edge headless, sem rede ----------
test('E3/W13: prazo do salvamento antes do anexo devolve not_submitted e o corpo tardio não anexa nem clica',()=>realPortalFixture({},async({driver,frame,pdf,saves})=>{
  driver.timeouts={...driver.timeouts,save:100};
  const original=driver.readDetailFrame.bind(driver);const gate=deferred();
  driver.readDetailFrame=async(...args)=>{await gate.promise;return original(...args);};
  assert.equal(await within(2000,()=>driver.uploadAndSavePersonResponse(ids,pdf,'information',100)),'not_submitted');
  gate.resolve();await wait(1500);
  assert.equal(saves().length,0);
  assert.equal(await frame().locator('#MainPage_FileUpload1').evaluate(input=>input.files.length),0);
}));
test('E3/W16: espera sem fim depois do clique em Alterar vira unverified, sem segundo envio',()=>realPortalFixture({keepOpen:true},async({driver,pdf,saves})=>{
  const saving=driver.uploadAndSavePersonResponse(ids,pdf,'information',20000);
  await until(()=>saves().length===1);
  // Simula cpi:close sem encerrar o navegador do fixture: mesmo caminho de cancelamento do prazo.
  driver.session.abort();
  assert.equal(await within(1000,()=>saving),'unverified');
  await wait(300);assert.equal(saves().length,1);
  await assert.rejects(driver.closeCompletedDetail(ids),/resposta não confirmada/);
}));

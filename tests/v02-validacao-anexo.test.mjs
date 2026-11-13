import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCpiPersonPdf } from '../src/main/cpi/person-pdf.ts';
import { CpiWorkflowStore } from '../src/main/cpi/workflow-store.ts';
import { executeCpiPersonCycle } from '../src/main/cpi/full-cycle.ts';
import { CpiFullAutoRunner } from '../src/main/cpi/full-auto-runner.ts';
import { classifyCpiError } from '../src/main/cpi/failure-classes.ts';
import { assessCpiPerson } from '../src/main/cpi/person-rules.ts';
import { normalizeDeskdataResponse } from '../src/shared/normalizer.ts';
import { realPortalFixture, ids, pdfName } from './helpers/cpi-portal-real.mjs';

// E6 / fix/v02-validacao-anexo-pdf — caso 542685/277705, com o DOM real do portal. Só dados fictícios.
const CPF='52998224725';
const field=(body,name)=>body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`))?.[1];

test('H-a: pasta de saída na raiz da unidade (J:\\) aceita o PDF CPI registrado',async()=>{
  const pdf='J:\\CPI_542685_277705_2026-11-13.pdf';
  const fs={
    realpath:async path=>path,
    stat:async path=>({isDirectory:()=>path==='J:\\',isFile:()=>path===pdf,size:4096}),
    open:async()=>({read:async buffer=>{buffer.write('%PDF-');return {bytesRead:5};},close:async()=>{}})
  };
  const record={id:'00000000-0000-4000-8000-000000000001',kind:'person',account:'a@exemplo.invalid',cpf:CPF,status:'ready',pdfPaths:[pdf]};
  assert.equal(await findCpiPersonPdf(record,CPF,'J:\\',ids,1000,fs),pdf);
});

// ---- Adaptador contra o DOM real (simulador) ----

for(const [classification,radio,label] of [['information','2','Há Informações'],['restrictions','3','Sim, Consta Restrições']]){
  test(`DOM real: ${label} completo (fontes, status, radio, arquivo, #stay, confirmação, modal fechado, fora da listagem)`,()=>realPortalFixture({},async({driver,pdf,saves,modalVisible,rowListed})=>{
    assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,classification,3000),'confirmed');
    assert.equal(saves().length,1);
    const body=saves()[0];
    assert.equal(field(body,'consta'),radio);
    assert.equal(field(body,'id_pesquisador'),'7');assert.equal(field(body,'id_pesquisador_prim'),'7');
    assert.equal(field(body,'stay'),'0');assert.equal(field(body,'resposta'),'','Texto vazio');
    assert.match(body,new RegExp(`name="arquivo"; filename="${pdfName}"`));
    assert.equal(await modalVisible(),false);
    await driver.closeCompletedDetail(ids,4000);
    assert.equal(await rowListed(),false);
  }));
}

test('Regra: nenhum processo → Há Informações (nunca Nada Consta)',()=>realPortalFixture({},async({driver,pdf,saves})=>{
  const data=normalizeDeskdataResponse({status:{code:4000},data:{basic:{tax_id:{number:CPF}},phones:{items:[]},emails:{items:[]},addresses:{items:[]},lawsuits:{items:[]}}});
  const assessment=assessCpiPerson(data);
  assert.deepEqual(assessment.classification,{state:'classified',result:'information',count:0});
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,assessment.classification.result,3000),'confirmed');
  assert.equal(field(saves()[0],'consta'),'2');
  assert.notEqual(field(saves()[0],'consta'),'0');
}));

test('Arquivo conferido: o input recebe exatamente o PDF CPI esperado; #stay marcado é desmarcado antes do clique',()=>realPortalFixture({stayChecked:true},async({driver,pdf,saves})=>{
  const steps=[];
  const timer={begin:step=>state=>steps.push(`${step}:${state}`)};
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'restrictions',3000,timer),'confirmed');
  assert.match(saves()[0],new RegExp(`filename="${pdfName}"`));
  assert.equal(field(saves()[0],'stay'),'0');
  assert.deepEqual(steps,['cpi_fill:success','cpi_attach:success','cpi_save:success']);
}));

test('Confirmação divergente: cancelada, nada enviado, resultado confirm_mismatch; modal fecha sem salvar',()=>realPortalFixture({
  confirmText:'Deseja Realmente Alterar esta Pesquisa?\nResultado >>> Nada Consta'
},async({driver,pdf,saves,modalVisible})=>{
  const marks=[];
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'restrictions',2000,undefined,async()=>{marks.push('submit_started');}),'confirm_mismatch');
  assert.deepEqual(marks,['submit_started']);assert.equal(saves().length,0);
  await driver.closeUnsavedDetail(ids);
  assert.equal(await modalVisible(),false);
}));

test('XHR antes do clique NÃO vai para revisão: registra só método e caminho e o envio segue',()=>realPortalFixture({
  beforeClickScript:"fetch('/zpersEspecial/pesquisas/upd_cad/aux_consta.aspx?id_sol=277705&cpf=1',{method:'POST',body:'x=1'});"
},async({driver,pdf,saves,requests,diagnostics})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'restrictions',3000),'confirmed');
  assert.equal(saves().length,1);
  assert.ok(requests().includes('POST /zpersEspecial/pesquisas/upd_cad/aux_consta.aspx'));
  const logged=diagnostics.filter(d=>d.event==='cpi_portal_request');
  assert.deepEqual(logged,[{event:'cpi_portal_request',method:'POST',path:'/zpersEspecial/pesquisas/upd_cad/aux_consta.aspx'}]);
  assert.doesNotMatch(JSON.stringify(diagnostics),/277705|cpf=/);
}));

test('Recarga do frame antes do clique: not_submitted (nada salvo) e o modal fecha sem salvar',()=>realPortalFixture({
  beforeClickScript:'location.reload();'
},async({driver,pdf,saves,modalVisible})=>{
  const steps=[],marks=[];
  const timer={begin:step=>(state,error)=>steps.push({step,state,errorType:error?.name})};
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',2000,timer,async()=>{marks.push('submit_started');}),'not_submitted');
  assert.deepEqual(marks,[],'checkpoint nunca gravado');assert.equal(saves().length,0);
  assert.equal(steps.at(-1).errorType,'CpiFrameReloadError');
  await driver.closeUnsavedDetail(ids);
  assert.equal(await modalVisible(),false);
}));

test('Modal que não fecha após Alterar: unverified (verification_required no ciclo)',()=>realPortalFixture({keepOpen:true},async({driver,pdf,saves})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',1500),'unverified');
  assert.equal(saves().length,1,'um único envio, sem repetir');
}));

test('Item que continua na listagem: a conclusão falha (verification_required no ciclo)',()=>realPortalFixture({keepRow:true},async({driver,pdf,saves,rowListed})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000),'confirmed');
  await assert.rejects(driver.closeCompletedDetail(ids,1500),/não confirmou a atualização da listagem/);
  assert.equal(await rowListed(),true);assert.equal(saves().length,1);
}));

test('Checkpoint é gravado depois do anexo e antes do clique; falha no checkpoint não clica',()=>realPortalFixture({},async({driver,pdf,saves,frame})=>{
  const seen=[];
  const result=await driver.uploadAndSavePersonResponse(ids,pdf,'restrictions',1500,undefined,async()=>{
    seen.push(await frame().locator('#MainPage_FileUpload1').evaluate(input=>input.files[0]?.name));
    throw Error('falha ao gravar');
  });
  assert.equal(result,'not_submitted');
  assert.deepEqual(seen,[pdfName]);assert.equal(saves().length,0,'"Alterar" não foi clicado');
}));

// ---- Ciclo: estados ----

const account='validacao@example.invalid';
const protector={isAvailable:async()=>true,encrypt:async t=>Buffer.from(t),decrypt:async b=>({result:b.toString(),shouldReEncrypt:false})};
const payload={status:{code:4000},data:{basic:{tax_id:{number:CPF}},phones:{items:[]},emails:{items:[]},addresses:{items:[]},
  lawsuits:{items:[{court_type:'Criminal'}]}}};
async function cycleEnv(run){
  const dir=await realpath(await mkdtemp(join(tmpdir(),'deskdata-v02-anexo-')));
  try{
    const store=new CpiWorkflowStore(dir,protector),calls=[];
    const record={id:'123e4567-e89b-12d3-a456-426614174000',account,cpf:CPF,kind:'person',status:'ready',queryCode:'Q-AAAAAAAAAA',pdfPaths:[]};
    let renders=0;
    const s={account,ids,outputFolder:dir,getCpf:async()=>{calls.push('open');return CPF;},
      getJob:()=>store.get(account,ids),claim:()=>store.claim(account,ids),mark:(stage,u)=>store.mark(account,ids,stage,u),
      findLatest:async()=>record,beginHistory:async()=>{throw Error('histórico novo indevido');},setQueryCode:async()=>{throw Error('POST indevido');},
      paidApproved:async()=>true,getCredits:async()=>{throw Error('consulta indevida');},verifyPaidBalance:async()=>{throw Error('consulta indevida');},
      submitCpf:async()=>{throw Error('POST indevido');},
      checkByCode:async()=>{calls.push('get');return {state:'ready',queryCode:record.queryCode,payload};},
      savePdf:async()=>{
        renders++;
        const path=join(dir,`CPI_${ids.pesquisaId}_${ids.solicitacaoId}_2026-11-13${renders>1?'-0'+renders:''}.pdf`);
        await writeFile(path,'%PDF-1.4\n'+'x'.repeat(200));record.pdfPaths.push(path);
      },
      uploadAndSave:async()=>{throw Error('defina no teste');},
      closeCompletedDetail:async()=>calls.push('close_completed'),closeUnsavedDetail:async()=>calls.push('close_unsaved')};
    await run({s,store,calls,record,renders:()=>renders});
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
}

test('Ciclo: falha antes de "Alterar" fecha sem salvar, mantém pdf_ready e reprocessa com o MESMO PDF, sem consulta',()=>cycleEnv(async({s,store,calls,record,renders})=>{
  const uploads=[];
  s.uploadAndSave=async pdf=>{uploads.push(pdf);return 'not_submitted';};
  assert.equal((await executeCpiPersonCycle(s)).state,'not_submitted');
  const job=await store.get(account,ids);
  assert.equal(job.stage,'pdf_ready');assert.equal(job.submittedAt,undefined,'submit_started nunca gravado');
  assert.equal(job.classification,'restrictions');
  assert.deepEqual(calls,['open','get','close_unsaved']);
  const order=[];
  s.uploadAndSave=async(pdf,_classification,beforeSubmit)=>{
    uploads.push(pdf);order.push('attach');
    await beforeSubmit();order.push((await store.get(account,ids)).stage);return 'confirmed';
  };
  s.closeCompletedDetail=async()=>{order.push('listing_checked');};
  assert.equal((await executeCpiPersonCycle(s)).state,'completed');
  assert.equal(uploads[1],uploads[0],'mesmo PDF');assert.equal(renders(),1,'PDF não regerado');
  assert.equal(calls.filter(c=>c==='get').length,1,'nenhuma consulta no reprocessamento');
  assert.deepEqual(order,['attach','submit_started','listing_checked']);
  assert.equal((await store.get(account,ids)).stage,'completed');assert.equal(record.pdfPaths.length,1);
}));

test('Ciclo: confirmação divergente → revisão ("confirmação divergente"), modal fechado sem salvar',()=>cycleEnv(async({s,store,calls})=>{
  s.uploadAndSave=async(_pdf,_c,beforeSubmit)=>{await beforeSubmit();return 'confirm_mismatch';};
  const result=await executeCpiPersonCycle(s);
  assert.equal(result.state,'review_required');assert.match(result.message,/Confirmação divergente/);
  assert.equal((await store.get(account,ids)).stage,'review_required');
  assert.ok(calls.includes('close_unsaved'));
}));

test('Ciclo: modal que não fecha → verification_required; item que continua na listagem → verification_required',()=>cycleEnv(async({s,store})=>{
  s.uploadAndSave=async(_pdf,_c,beforeSubmit)=>{await beforeSubmit();return 'unverified';};
  const open=await executeCpiPersonCycle(s);
  assert.equal(open.state,'verification_required');assert.match(open.message,/modal não fechou/);
  assert.equal((await store.get(account,ids)).stage,'verification_required');
}));

test('Ciclo: item que continua na listagem após o modal fechar → verification_required, nunca completed',()=>cycleEnv(async({s,store})=>{
  s.uploadAndSave=async(_pdf,_c,beforeSubmit)=>{await beforeSubmit();return 'confirmed';};
  s.closeCompletedDetail=async()=>{throw new Error('A CPI não confirmou a atualização da listagem após responder.');};
  const result=await executeCpiPersonCycle(s);
  assert.equal(result.state,'verification_required');assert.match(result.message,/continua na listagem/);
  assert.equal((await store.get(account,ids)).stage,'verification_required');
}));

test('Ciclo: sem checkpoint, exceção do adaptador é "não enviado"; com checkpoint, verification_required',()=>cycleEnv(async({s,store})=>{
  s.uploadAndSave=async()=>{throw Error('falha antes do clique');};
  assert.equal((await executeCpiPersonCycle(s)).state,'not_submitted');
  assert.equal((await store.get(account,ids)).stage,'pdf_ready');
  s.uploadAndSave=async(_pdf,_c,beforeSubmit)=>{await beforeSubmit();throw Error('conexão perdida após o clique');};
  assert.equal((await executeCpiPersonCycle(s)).state,'verification_required');
}));

test('Ciclo: modal que não fecha sem salvar é parada sistêmica (portal bloqueado)',()=>cycleEnv(async({s})=>{
  s.uploadAndSave=async()=>'not_submitted';
  s.closeUnsavedDetail=async()=>{throw Error('Controle único de fechamento da pesquisa CPI não confirmado.');};
  const error=await executeCpiPersonCycle(s).then(()=>null,e=>e);
  assert.match(error.message,/portal bloqueado/);assert.equal(classifyCpiError(error),'portal_layout');
}));

// ---- Diagnóstico e pausa ----

test('Diagnóstico: canal de três partes, motivo fixo, método e caminho chegam ao log; texto livre e query não',async()=>{
  const { DiagnosticLogger } = await import('../src/main/diagnostics.ts');
  const { readFile, readdir } = await import('node:fs/promises');
  const dir=await mkdtemp(join(tmpdir(),'deskdata-v02-diag-'));
  try{
    const logger=new DiagnosticLogger(dir);
    await logger.write('ipc_success',{channel:'cpi:auto:pause',durationMs:1});
    await logger.write('ipc_success',{channel:'cpi:auto:pause:extra:x'});
    await logger.write('timing_step',{step:'cpi_fill',state:'failed',errorType:'CpiFrameReloadError',detail:'texto livre'});
    await logger.write('cpi_portal_request',{method:'POST',path:'/zpersEspecial/pesquisas/upd_cad/aux.aspx'});
    await logger.write('cpi_portal_request',{method:'POST',path:'/x.aspx?cpf=52998224725'});
    await logger.write('cpi_portal_request',{method:'GET',path:'/pessoa/52998224725'});
    const [file]=await readdir(dir);
    const rows=(await readFile(join(dir,file),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(rows[0].channel,'cpi:auto:pause');assert.equal(rows[1].channel,undefined);
    assert.equal(rows[2].errorType,'CpiFrameReloadError');assert.equal(rows[2].detail,undefined);
    assert.equal(rows[3].path,'/zpersEspecial/pesquisas/upd_cad/aux.aspx');assert.equal(rows[3].method,'POST');
    assert.equal(rows[4].path,undefined);assert.equal(rows[5].path,undefined);
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});

function sequenceRunner(results){
  let i=0;
  return new CpiFullAutoRunner(async()=>{
    const next=results[Math.min(i++,results.length-1)];
    if(next instanceof Error)throw next;
    return next;
  },()=>{},{sleep:async()=>{}});
}
const filterTimeout=()=>new Error('Etapa filtro CPI 29: falha ao atualizar a listagem.',
  {cause:Object.assign(new Error('Tempo limite (cpi_filter).'),{name:'TimeoutError'})});
async function settle(runner){for(let i=0;i<100&&runner.isActive();i++)await new Promise(r=>setTimeout(r,5));}

test('Pausa: envio sem confirmação (modal que não fecha) pausa já no envio, com a pesquisa na mensagem',async()=>{
  const runner=sequenceRunner([{kind:'item',found:1,outcome:{...ids,state:'verification_required',
    message:'Envio sem confirmação: o modal não fechou no prazo após Alterar. Verificar manualmente, sem reenvio.'}},
    filterTimeout(),filterTimeout(),filterTimeout()]);
  await runner.start(30);await settle(runner);
  const status=runner.status();
  assert.equal(status.phase,'error');assert.equal(status.checks,1,'nenhum ciclo de filtro depois do envio incerto');
  assert.match(status.lastMessage,/542685\/277705: Envio sem confirmação: o modal não fechou.*pausada sem reenvio/i);
});

test('Pausa: 3 falhas consecutivas da mesma classe (filtro em tempo limite) pausam com mensagem na interface',async()=>{
  const runner=sequenceRunner([filterTimeout(),filterTimeout(),filterTimeout(),{kind:'idle',found:0}]);
  await runner.start(30);await settle(runner);
  const status=runner.status();
  assert.equal(status.phase,'error');assert.equal(status.checks,3);
  assert.deepEqual(status.failureStreak,{kind:'timeout',count:3});
  assert.match(status.lastMessage,/3 falhas consecutivas: tempo limite excedido.*pausada/i);
});

test('Pausa: 3 falhas seguidas antes de "Alterar" pausam (classe submit_not_sent)',async()=>{
  const runner=sequenceRunner([{kind:'item',found:1,outcome:{...ids,state:'not_submitted',message:'Falha antes do clique.'}}]);
  await runner.start(30);await settle(runner);
  assert.equal(runner.status().phase,'error');assert.equal(runner.status().checks,3);
  assert.match(runner.status().lastMessage,/3 falhas consecutivas: envio CPI não realizado/);
});

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
import { portalFixture, ids, editable } from './helpers/cpi-portal.mjs';

// E6 / fix/v02-validacao-anexo-pdf — caso 542685/277705. Só dados fictícios; nenhuma chamada real.
const CPF='52998224725';

// ---- Hipóteses (escritas antes da correção) ----

test('H-a: pasta de saída na raiz da unidade (J:\\) aceita o PDF CPI registrado',async()=>{
  const target={pesquisaId:'542685',solicitacaoId:'277705'};
  const pdf='J:\\CPI_542685_277705_2026-11-13.pdf';
  const fs={
    realpath:async path=>path,
    stat:async path=>({isDirectory:()=>path==='J:\\',isFile:()=>path===pdf,size:4096}),
    open:async()=>({read:async buffer=>{buffer.write('%PDF-');return {bytesRead:5};},close:async()=>{}})
  };
  const record={id:'00000000-0000-4000-8000-000000000001',kind:'person',account:'a@exemplo.invalid',cpf:CPF,status:'ready',pdfPaths:[pdf]};
  assert.equal(await findCpiPersonPdf(record,CPF,'J:\\',target,1000,fs),pdf);
});

test('H-b: input de arquivo oculto dentro do frame do modal ainda recebe o PDF e o envio é confirmado',()=>portalFixture({
  result:'restrictions',initial:editable().replace('<input type="file"','<input type="file" style="display:none"')
},async({driver,pdf,posts,attachedFile})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'restrictions',2000),'confirmed');
  assert.equal(posts(),1);assert.ok(attachedFile());
}));

// Reprodução do observado: classificação marcada, "Em Arquivo" vazio, "Alterar" não clicado, falha em cpi_fill.
// O portal dispara uma requisição POST no frame ao marcar "Sim, Consta Restrições" (antes do anexo).
const postbackOnRestrictions=()=>editable().replace('id="restrictions" name="result"',
  'id="restrictions" onclick="fetch(location.href,{method:\'POST\',body:\'aux=1\'})" name="result"');

test('H-d: POST do portal ao marcar a classificação, antes do anexo, não vira verification_required',()=>portalFixture({
  result:'restrictions',initial:postbackOnRestrictions()
},async({driver,page,pdf,posts,attachedFile})=>{
  const steps=[];
  const timer={begin:step=>(state,error)=>steps.push({step,state,errorType:error?.name})};
  const result=await driver.uploadAndSavePersonResponse(ids,pdf,'restrictions',1000,timer);
  const frame=page.locator('#sb-content').contentFrame();
  assert.equal(await frame.locator('#restrictions').isChecked(),true,'classificação marcada como no observado');
  assert.equal(attachedFile(),null,'nenhum anexo');
  assert.equal(posts(),1,'só o POST do próprio portal; "Alterar" não foi clicado');
  // Antes do clique em "Alterar" nada foi salvo pelo agente: não é envio incerto.
  assert.equal(result,'not_submitted_postback');
  assert.deepEqual(steps.at(-1),{step:'cpi_fill',state:'failed',errorType:'CpiEarlyPostbackError'});
}));

test('H-c: confirmação com outro texto só falha DEPOIS do clique em "Alterar" (assinatura diferente da observada)',()=>portalFixture({
  result:'restrictions',initial:editable().replace("confirm('Deseja alterar esta pesquisa?')","confirm('Confirma a operação?')")
},async({driver,pdf,posts,attachedFile})=>{
  const steps=[];
  const timer={begin:step=>(state,error)=>steps.push({step,state,errorType:error?.name})};
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'restrictions',800,timer),'unverified');
  assert.ok(attachedFile(),'o anexo aconteceu');assert.equal(posts(),0,'confirm recusado: nenhum POST');
  assert.equal(steps.at(-1).step,'cpi_save','falha em cpi_save, não em cpi_fill como no caso real');
}));

// ---- Correção: checkpoint antes do clique, estado em falha, fechamento sem salvar e pausa ----

const account='validacao@example.invalid',item={pesquisaId:'542685',solicitacaoId:'277705'};
const protector={isAvailable:async()=>true,encrypt:async t=>Buffer.from(t),decrypt:async b=>({result:b.toString(),shouldReEncrypt:false})};
const payload={status:{code:4000},data:{basic:{tax_id:{number:CPF}},phones:{items:[]},emails:{items:[]},addresses:{items:[]},
  lawsuits:{items:[{court_type:'Criminal'}]}}};
async function cycleEnv(run){
  const dir=await realpath(await mkdtemp(join(tmpdir(),'deskdata-v02-anexo-')));
  try{
    const store=new CpiWorkflowStore(dir,protector),calls=[];
    const record={id:'123e4567-e89b-12d3-a456-426614174000',account,cpf:CPF,kind:'person',status:'ready',queryCode:'Q-AAAAAAAAAA',pdfPaths:[]};
    let renders=0;
    const s={account,ids:item,outputFolder:dir,getCpf:async()=>{calls.push('open');return CPF;},
      getJob:()=>store.get(account,item),claim:()=>store.claim(account,item),mark:(stage,u)=>store.mark(account,item,stage,u),
      findLatest:async()=>record,beginHistory:async()=>{throw Error('histórico novo indevido');},setQueryCode:async()=>{throw Error('POST indevido');},
      paidApproved:async()=>true,getCredits:async()=>{throw Error('consulta indevida');},verifyPaidBalance:async()=>{throw Error('consulta indevida');},
      submitCpf:async()=>{throw Error('POST indevido');},
      checkByCode:async()=>{calls.push('get');return {state:'ready',queryCode:record.queryCode,payload};},
      savePdf:async()=>{
        renders++;
        const path=join(dir,`CPI_${item.pesquisaId}_${item.solicitacaoId}_2026-11-13${renders>1?'-0'+renders:''}.pdf`);
        await writeFile(path,'%PDF-1.4\n'+'x'.repeat(200));record.pdfPaths.push(path);
      },
      uploadAndSave:async()=>{throw Error('defina no teste');},
      closeCompletedDetail:async()=>calls.push('close_completed'),closeUnsavedDetail:async()=>calls.push('close_unsaved')};
    await run({s,store,calls,record,renders:()=>renders});
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
}

test('Item 4: falha antes de "Alterar" fecha o modal sem salvar, mantém pdf_ready e reprocessa com o MESMO PDF, sem consulta',()=>cycleEnv(async({s,store,calls,record,renders})=>{
  const uploads=[];
  s.uploadAndSave=async pdf=>{uploads.push(pdf);return 'not_submitted';};
  const first=await executeCpiPersonCycle(s);
  assert.equal(first.state,'not_submitted');
  const job=await store.get(account,item);
  assert.equal(job.stage,'pdf_ready');assert.equal(job.submittedAt,undefined,'submit_started nunca gravado');
  assert.equal(job.classification,'restrictions');
  assert.deepEqual(calls,['open','get','close_unsaved']);
  // Reprocessamento: nenhum GET/POST e nenhum PDF novo; o mesmo arquivo é anexado; sequência completa até completed.
  const order=[];
  s.uploadAndSave=async(pdf,_classification,beforeSubmit)=>{
    uploads.push(pdf);order.push('attach');
    await beforeSubmit();order.push((await store.get(account,item)).stage);return 'confirmed';
  };
  s.closeCompletedDetail=async()=>{order.push('close_completed');};
  const second=await executeCpiPersonCycle(s);
  assert.equal(second.state,'completed');
  assert.equal(uploads[1],uploads[0],'mesmo PDF');assert.equal(renders(),1,'PDF não regerado');
  assert.equal(calls.filter(c=>c==='get').length,1,'nenhuma consulta no reprocessamento');
  assert.deepEqual(order,['attach','submit_started','close_completed']);
  assert.equal((await store.get(account,item)).stage,'completed');
  assert.equal(record.pdfPaths.length,1);
}));

test('Item 4: postback do portal antes de "Alterar" vai para revisão (não verification_required) e o modal é fechado sem salvar',()=>cycleEnv(async({s,store,calls})=>{
  s.uploadAndSave=async()=>'not_submitted_postback';
  const result=await executeCpiPersonCycle(s);
  assert.equal(result.state,'review_required');
  const job=await store.get(account,item);
  assert.equal(job.stage,'review_required');assert.equal(job.submittedAt,undefined);
  assert.ok(calls.includes('close_unsaved'));
}));

test('Item 4: verification_required só depois do checkpoint de clique; sem checkpoint, exceção do adaptador é "não enviado"',()=>cycleEnv(async({s,store})=>{
  s.uploadAndSave=async()=>{throw Error('falha antes do clique');};
  assert.equal((await executeCpiPersonCycle(s)).state,'not_submitted');
  assert.equal((await store.get(account,item)).stage,'pdf_ready');
  s.uploadAndSave=async(_pdf,_c,beforeSubmit)=>{await beforeSubmit();throw Error('conexão perdida após o clique');};
  assert.equal((await executeCpiPersonCycle(s)).state,'verification_required');
  assert.equal((await store.get(account,item)).stage,'verification_required');
}));

test('Item 4: modal que não fecha sem salvar é parada sistêmica (portal bloqueado), não falha do item',()=>cycleEnv(async({s})=>{
  s.uploadAndSave=async()=>'not_submitted';
  s.closeUnsavedDetail=async()=>{throw Error('Controle único de fechamento da pesquisa CPI não confirmado.');};
  const error=await executeCpiPersonCycle(s).then(()=>null,e=>e);
  assert.match(error.message,/portal bloqueado/);
  assert.equal(classifyCpiError(error),'portal_layout');
}));

test('Adaptador: checkpoint é gravado depois do anexo e antes do clique; falha no checkpoint não clica',()=>portalFixture({result:'restrictions'},async({driver,pdf,posts,attachedFile})=>{
  const seen=[];
  const result=await driver.uploadAndSavePersonResponse(ids,pdf,'restrictions',800,undefined,async()=>{
    seen.push({attached:!!attachedFile(),posts:posts()});throw Error('falha ao gravar');
  });
  assert.equal(result,'not_submitted');
  assert.deepEqual(seen,[{attached:true,posts:0}]);
  assert.equal(posts(),0,'"Alterar" não foi clicado');
}));

test('Diagnóstico: canal de três partes (cpi:auto:pause) e motivo fixo da falha chegam ao log; texto livre não',async()=>{
  const { DiagnosticLogger } = await import('../src/main/diagnostics.ts');
  const { readFile, readdir } = await import('node:fs/promises');
  const dir=await mkdtemp(join(tmpdir(),'deskdata-v02-diag-'));
  try{
    const logger=new DiagnosticLogger(dir);
    await logger.write('ipc_success',{channel:'cpi:auto:pause',durationMs:1});
    await logger.write('ipc_success',{channel:'cpi:auto:pause:extra:x'});
    await logger.write('timing_step',{step:'cpi_fill',state:'failed',errorType:'CpiEarlyPostbackError',detail:'texto livre'});
    const [file]=await readdir(dir);
    const rows=(await readFile(join(dir,file),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(rows[0].channel,'cpi:auto:pause');assert.equal(rows[1].channel,undefined);
    assert.equal(rows[2].errorType,'CpiEarlyPostbackError');assert.equal(rows[2].detail,undefined);
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

test('Item 5: sequência observada (envio sem confirmação + filtro em tempo limite) pausa já no envio, com mensagem',async()=>{
  const runner=sequenceRunner([{kind:'item',found:1,outcome:{...item,state:'verification_required',message:'Envio efetuado sem confirmação suficiente.'}},
    filterTimeout(),filterTimeout(),filterTimeout()]);
  await runner.start(30);await settle(runner);
  const status=runner.status();
  assert.equal(status.phase,'error');
  assert.equal(status.checks,1,'nenhum ciclo de filtro depois do envio incerto');
  assert.match(status.lastMessage,/542685\/277705: envio sem confirmação.*pausada sem reenvio/i);
});

test('Item 5: 3 falhas consecutivas da mesma classe (filtro em tempo limite) pausam com mensagem na interface',async()=>{
  const runner=sequenceRunner([filterTimeout(),filterTimeout(),filterTimeout(),{kind:'idle',found:0}]);
  await runner.start(30);await settle(runner);
  const status=runner.status();
  assert.equal(status.phase,'error');assert.equal(status.checks,3);
  assert.deepEqual(status.failureStreak,{kind:'timeout',count:3});
  assert.match(status.lastMessage,/3 falhas consecutivas: tempo limite excedido.*pausada/i);
});

test('Item 5: 3 falhas seguidas antes de "Alterar" pausam (classe submit_not_sent)',async()=>{
  const runner=sequenceRunner([{kind:'item',found:1,outcome:{...item,state:'not_submitted',message:'Falha antes do clique.'}}]);
  await runner.start(30);await settle(runner);
  assert.equal(runner.status().phase,'error');assert.equal(runner.status().checks,3);
  assert.match(runner.status().lastMessage,/3 falhas consecutivas: envio CPI não realizado/);
});

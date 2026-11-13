import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CpiWorkflowStore } from '../src/main/cpi/workflow-store.ts';
import { reconcileCpiWorkflow } from '../src/main/cpi/workflow-reconciliation.ts';
import { OperationGate as ApplicationOperations } from '../src/main/operation-gate.ts';

const protector={isAvailable:async()=>true,encrypt:async text=>Buffer.from(text),decrypt:async buf=>({result:buf.toString()})};
const ids={pesquisaId:'537987',solicitacaoId:'275064'};
const recordId='123e4567-e89b-12d3-a456-426614174000';
async function withStore(run){const dir=await mkdtemp(join(tmpdir(),'deskdata-reconcile-'));try{await run(new CpiWorkflowStore(dir,protector),dir);}finally{await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}}

test('pendências paginadas isolam contas, preservam motivos e estado vazio',()=>withStore(async store=>{
 await store.claim('a',ids);
 await store.mark('a',ids,'review_required',{reviewReason:'unknown_court_type'});
 await store.claim('a',{pesquisaId:'537988',solicitacaoId:'275065'});
 await store.mark('a',{pesquisaId:'537988',solicitacaoId:'275065'},'verification_required');
 await store.claim('b',{pesquisaId:'537989',solicitacaoId:'275066'});
 await store.mark('b',{pesquisaId:'537989',solicitacaoId:'275066'},'submit_started');
 const first=await store.listPending('A',0,1);
 assert.equal(first.total,2);assert.equal(first.items.length,1);
 assert.equal((await store.listPending('a',1,1)).items.length,1);
 assert.equal((await store.listPending('a',2,1)).items.length,0);
 assert.equal((await store.listPending('b',0,10)).total,1);
 assert.equal((await store.listPending('c',0,10)).total,0);
 assert.equal((await store.get('a',ids)).reviewReason,'unknown_court_type');
 await assert.rejects(store.listPending('a',-1,10));
 await assert.rejects(store.listPending('a',0,101));
}));

test('reconciliação positiva exige evidência local e remota, persiste auditoria e bloqueia reenvio',()=>withStore(async(store,dir)=>{
 await store.claim('a',ids);
 await store.mark('a',ids,'pdf_ready',{historyRecordId:recordId,classification:'information'});
 await store.mark('a',ids,'verification_required');
 let inspected=0;
 const services={store,account:'a',ids,
  checkLocal:async()=>({ready:true,cpf:'52998224725'}),
  inspectRemote:async()=>{inspected++;return 'confirmed';}};
 const result=await reconcileCpiWorkflow(services);
 assert.equal(result.stage,'completed');assert.equal(inspected,1);
 const reloaded=new CpiWorkflowStore(dir,protector);
 assert.equal((await reloaded.get('a',ids)).verificationEvents.at(-1).reason,'confirmed');
 await assert.rejects(reloaded.mark('a',ids,'submit_started'),/não será repetido/);
 await assert.rejects(reconcileCpiWorkflow({...services,store:reloaded}),/não está pendente/);
}));

test('resultado negativo ou inconclusivo conserva bloqueio e registra motivo seguro',()=>withStore(async(store,dir)=>{
 await store.claim('a',ids);
 await store.mark('a',ids,'submit_started',{historyRecordId:recordId,classification:'restrictions'});
 const services={store,account:'a',ids,checkLocal:async()=>({ready:true,cpf:'52998224725'}),inspectRemote:async()=> 'unverified'};
 assert.equal((await reconcileCpiWorkflow(services)).stage,'verification_required');
 assert.equal((await reconcileCpiWorkflow({...services,inspectRemote:async()=> 'unavailable'})).stage,'verification_required');
 const persisted=await new CpiWorkflowStore(dir,protector).get('a',ids);
 assert.deepEqual(persisted.verificationEvents.map(event=>event.reason),['remote_unverified','remote_unavailable']);
 await assert.rejects(store.mark('a',ids,'pdf_ready'),/não será repetido/);
}));

test('revisão judicial sem classificação não vira completed e outra conta não pode reconciliar',()=>withStore(async store=>{
 await store.claim('a',ids);await store.mark('a',ids,'review_required',{reviewReason:'missing_court_type'});
 let remote=0;
 await assert.rejects(reconcileCpiWorkflow({store,account:'b',ids,checkLocal:async()=>({ready:true,cpf:'52998224725'}),inspectRemote:async()=>{remote++;return 'confirmed';}}),/não está pendente/);
 const result=await reconcileCpiWorkflow({store,account:'a',ids,checkLocal:async()=>({ready:true,cpf:'52998224725'}),inspectRemote:async()=>{remote++;return 'confirmed';}});
 assert.equal(result.stage,'review_required');assert.equal(remote,0);
 assert.equal(result.verificationEvents.at(-1).reason,'local_incomplete');
}));

test('reserva de operação impede duas reconciliações concorrentes',()=>withStore(async store=>{
 await store.claim('a',ids);await store.mark('a',ids,'verification_required',{historyRecordId:recordId,classification:'information'});
 const operations=new ApplicationOperations();let resolve;
 const gate=new Promise(done=>{resolve=done;});let inspections=0;
 const services={store,account:'a',ids,checkLocal:async()=>({ready:true,cpf:'52998224725'}),inspectRemote:async()=>{inspections++;await gate;return 'unverified';}};
 const first=operations.run(()=>reconcileCpiWorkflow(services),true);
 await assert.rejects(operations.run(()=>reconcileCpiWorkflow(services),true),/Outra operação/);
 resolve();await first;assert.equal(inspections,1);
}));

test('arquivo inválido bloqueia listagem e reconciliação sem efeitos remotos',()=>withStore(async(store,dir)=>{
 await writeFile(join(dir,'cpi-workflows.bin'),'garbage');let inspected=0;
 await assert.rejects(store.listPending('a',0,10),/corrompida/);
 await assert.rejects(reconcileCpiWorkflow({store,account:'a',ids,checkLocal:async()=>({ready:true,cpf:'52998224725'}),inspectRemote:async()=>{inspected++;return 'confirmed';}}),/corrompida/);
 assert.equal(inspected,0);
}));

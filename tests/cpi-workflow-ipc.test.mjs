import test from 'node:test';
import assert from 'node:assert/strict';
import { withMainProcess } from './helpers/main-process.mjs';
import { CpiWorkflowStore } from '../src/main/cpi/workflow-store.ts';

const protector={isAvailable:async()=>true,encrypt:async text=>Buffer.from(text),decrypt:async buf=>({result:buf.toString()})};
const ids={pesquisaId:'537987',solicitacaoId:'275064'};

test('IPC CPI lista somente pendências da conta e não recebe estágio escolhido pelo renderer',()=>{
 let remote=0;
 return withMainProcess(async()=>{throw Error('POST não permitido');},async({invoke,root})=>{
  const store=new CpiWorkflowStore(root,protector);
  await store.claim('ipc-tests@example.invalid',ids);
  await store.mark('ipc-tests@example.invalid',ids,'review_required',{reviewReason:'unknown_court_type'});
  await store.claim('outra@example.invalid',{pesquisaId:'537988',solicitacaoId:'275065'});
  await store.mark('outra@example.invalid',{pesquisaId:'537988',solicitacaoId:'275065'},'verification_required');
  const page=await invoke('cpi:workflow:pending',0,10);
  assert.equal(page.total,1);assert.equal(page.items[0].reviewReason,'unknown_court_type');
  assert.equal(Object.hasOwn(page.items[0],'account'),false);
  assert.equal(Object.hasOwn(page.items[0],'historyRecordId'),false);
  assert.equal((await invoke('cpi:workflow:pending',1,10)).items.length,0);
  await assert.rejects(invoke('cpi:workflow:pending',0,101),/Paginação/);
  const result=await invoke('cpi:workflow:verify',ids,'completed');
  assert.equal(result.stage,'review_required');assert.equal(result.reason,'local_incomplete');
  assert.equal(remote,0);
  const persisted=await new CpiWorkflowStore(root,protector).get('ipc-tests@example.invalid',ids);
  assert.equal(persisted.stage,'review_required');
  assert.equal(persisted.verificationEvents.length,1);
 },{cpiOpen:true,inspectPersisted:async()=>{remote++;return 'confirmed';}});
});

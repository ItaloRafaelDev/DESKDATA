import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { CpiWorkflowStore } from '../src/main/cpi/workflow-store.ts';
import { withMainProcess } from './helpers/main-process.mjs';

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
const pending=async()=>({state:'pending',queryCode:'Q-AAAAAAAAAA'});
const protector={isAvailable:async()=>true,encrypt:async value=>Buffer.from(value),decrypt:async value=>({result:value.toString()})};

test('fechar CPI durante varredura aguarda a conclusão e pausa o agente',()=>{
  const entered=deferred(),scan=deferred();let finished=false;
  return withMainProcess(pending,async({invoke})=>{
    await invoke('cpi:auto:start',30);
    await entered.promise;
    const closing=invoke('cpi:close').then(()=>{finished=true;});
    await nextTurn();
    assert.equal(finished,false);
    scan.resolve();
    await closing;
    assert.equal((await invoke('cpi:auto:status')).phase,'paused');
  },{cpiOpen:true,filter:async()=>{entered.resolve();await scan.promise;return {state:'empty',total:0,typeId:'29'};}});
});

test('sair da conta durante varredura aguarda o ciclo e encerra a sessão',()=>{
  const entered=deferred(),scan=deferred();let finished=false;
  return withMainProcess(pending,async({invoke})=>{
    await invoke('cpi:auto:start',30);
    await entered.promise;
    const logout=invoke('auth:logout').then(()=>{finished=true;});
    await nextTurn();
    assert.equal(finished,false);
    scan.resolve();
    await logout;
    await assert.rejects(invoke('cpi:auto:status'),/Autentique-se/);
  },{cpiOpen:true,filter:async()=>{entered.resolve();await scan.promise;return {state:'empty',total:0,typeId:'29'};}});
});

test('duas saídas da conta simultâneas aceitam somente uma',()=>withMainProcess(pending,async({invoke})=>{
  const results=await Promise.allSettled([invoke('auth:logout'),invoke('auth:logout')]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.filter(result=>result.status==='rejected').length,1);
  await assert.rejects(invoke('cpi:auto:status'),/Autentique-se/);
}));

test('pausa durante varredura preserva submit_started no disco',()=>{
  const entered=deferred(),scan=deferred();
  const ids={pesquisaId:'573987',solicitacaoId:'275064'};
  return withMainProcess(pending,async({invoke,root})=>{
    const store=new CpiWorkflowStore(root,protector);
    await store.claim('ipc-tests@example.invalid',ids);
    await store.mark('ipc-tests@example.invalid',ids,'submit_started');
    await invoke('cpi:auto:start',30);
    await entered.promise;
    const closing=invoke('cpi:close');
    scan.resolve();
    await closing;
    assert.equal((await new CpiWorkflowStore(root,protector).get('ipc-tests@example.invalid',ids)).stage,'submit_started');
  },{cpiOpen:true,filter:async()=>{entered.resolve();await scan.promise;return {state:'empty',total:0,typeId:'29'};}});
});

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

for(const channel of ['cpi:close','auth:logout']){
  test(`${channel} aguarda a varredura do monitor sem interromper a leitura`,()=>{
    const entered=deferred(),scan=deferred();let finished=false,readCompleted=false;
    return withMainProcess(pending,async({invoke})=>{
      await invoke('cpi:monitor:start',30);
      await entered.promise;
      const stopping=invoke(channel).then(()=>{finished=true;});
      await nextTurn();
      assert.equal(finished,false);
      scan.resolve();
      try{await stopping;}
      catch(error){await invoke('cpi:monitor:pause').catch(()=>{});throw error;}
      assert.equal(readCompleted,true);
      if(channel==='cpi:close')assert.equal((await invoke('cpi:monitor:status')).phase,'stopped');
      else await assert.rejects(invoke('cpi:monitor:status'),/Autentique-se/);
    },{cpiOpen:true,filter:async()=>{
      entered.resolve();await scan.promise;readCompleted=true;
      return {state:'empty',total:0,typeId:'29'};
    }});
  });
}

test('logout rejeitado durante manutenção não pausa o agente',()=>{
  const entered=deferred(),answer=deferred();
  return withMainProcess(pending,async({invoke})=>{
    const cleaning=invoke('maintenance:clean',{history:true,pdfs:false});
    await entered.promise;
    assert.equal((await invoke('cpi:auto:status')).phase,'stopped');
    await assert.rejects(invoke('auth:logout'),/operação|Conclua/i);
    const phase=(await invoke('cpi:auto:status')).phase;
    answer.resolve({response:0});
    await cleaning;
    assert.equal(phase,'stopped');
  },{showMessageBox:()=>{entered.resolve();return answer.promise;},maintenance:async()=>({deletedRecords:0,deletedPdfs:0,missingPdfs:0})});
});

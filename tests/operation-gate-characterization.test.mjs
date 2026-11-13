import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { withMainProcess } from './helpers/main-process.mjs';

// E4 — caracterização da concorrência ANTES da troca pelo OperationGate. Estes testes passam no código
// anterior e precisam passar sem alteração depois. Só dados fictícios; nenhum serviço real.
const CPF='52998224725';
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
const pending=async(_cpf,onCode)=>{await onCode('Q-AAAAAAAAAA');return {state:'pending',queryCode:'Q-AAAAAAAAAA'};};
/** Consulta manual presa no POST: mantém a operação exclusiva ocupada até `release`. */
function heldQuery(){
  const entered=deferred(),release=deferred();
  return {entered,release,submit:async(...args)=>{entered.resolve();await release.promise;return pending(...args);}};
}

test('caracterização: com uma consulta em andamento, outras operações exclusivas são recusadas com mensagem clara',()=>{
  const held=heldQuery();
  return withMainProcess(held.submit,async({invoke})=>{
    const query=invoke('api:query',CPF);
    await held.entered.promise;
    for(const [channel,...args] of [['api:query','11144477735'],['history:regenerate','x'],['backup:create'],
      ['maintenance:clean',{history:true,pdfs:false}],['report:save-again'],['cpi:open']]){
      await assert.rejects(invoke(channel,...args),/Outra operação está em andamento\. Conclua a operação atual\./,channel);
    }
    held.release.resolve();
    assert.equal((await query).state,'pending');
  });
});

test('caracterização: leituras não exclusivas continuam disponíveis durante a consulta',()=>{
  const held=heldQuery();
  return withMainProcess(held.submit,async({invoke})=>{
    const query=invoke('api:query',CPF);
    await held.entered.promise;
    assert.ok(Array.isArray(await invoke('history:list')));
    assert.equal((await invoke('cpi:auto:status')).phase,'stopped');
    assert.equal(typeof (await invoke('settings:get')).outputFolder,'string');
    held.release.resolve();await query;
  });
});

test('caracterização: falha dentro da operação libera a exclusividade',()=>{
  let fail=true;
  return withMainProcess(async(...args)=>{if(fail)throw new Error('falha simulada no POST');return pending(...args);},async({invoke})=>{
    await assert.rejects(invoke('api:query',CPF),/falha simulada/);
    fail=false;
    assert.equal((await invoke('company:query','11222333000181')).state,'pending');
  });
});

test('caracterização: sair da conta durante consulta manual é recusado sem encerrar a sessão',()=>{
  const held=heldQuery();
  return withMainProcess(held.submit,async({invoke,events})=>{
    const query=invoke('api:query',CPF);
    await held.entered.promise;
    await assert.rejects(invoke('auth:logout'),/Conclua a operação atual|Outra operação está em andamento/);
    await assert.rejects(invoke('cpi:close'),/Outra operação está em andamento/);
    assert.equal(events.includes('session_reset'),false);
    held.release.resolve();await query;
    assert.ok(Array.isArray(await invoke('history:list')));
  });
});

test('caracterização: iniciar FULL AUTO ou monitor durante operação exclusiva é recusado',()=>{
  const held=heldQuery();
  return withMainProcess(held.submit,async({invoke})=>{
    const query=invoke('api:query',CPF);
    await held.entered.promise;
    await assert.rejects(invoke('cpi:auto:start',30),/conclua a operação atual/i);
    await assert.rejects(invoke('cpi:monitor:start',30),/Conclua a operação atual antes de iniciar o monitor/);
    held.release.resolve();await query;
    assert.equal((await invoke('cpi:auto:status')).phase,'stopped');
  },{cpiOpen:true});
});

test('caracterização: durante a troca de sessão, canais que exigem conta informam a troca em andamento',()=>{
  const closing=deferred(),release=deferred();
  return withMainProcess(pending,async({invoke})=>{
    const logout=invoke('auth:logout');
    await closing.promise;
    await assert.rejects(invoke('history:list'),/Troca de sessão em andamento/);
    assert.equal((await invoke('settings:get')).paidQueriesApproved,false);
    await assert.rejects(invoke('auth:login','outra@example.invalid','senha-ficticia',false),/Outra operação está em andamento/);
    release.resolve();await logout;
    await assert.rejects(invoke('history:list'),/Autentique-se/);
  },{cpiClose:async()=>{closing.resolve();await release.promise;}});
});

test('caracterização: login com sessão ativa é recusado e a sessão continua',()=>withMainProcess(pending,async({invoke})=>{
  await assert.rejects(invoke('auth:login','outra@example.invalid','senha-ficticia',false),/Encerre a sessão atual/);
  assert.ok(Array.isArray(await invoke('history:list')));
}));

test('caracterização: limpeza recusa nova limpeza e é liberada após cancelar',()=>{
  const entered=deferred(),answer=deferred();
  return withMainProcess(pending,async({invoke})=>{
    const cleaning=invoke('maintenance:clean',{history:true,pdfs:false});
    await entered.promise;
    await assert.rejects(invoke('maintenance:clean',{history:true,pdfs:false}),/Outra operação está em andamento/);
    await assert.rejects(invoke('api:query',CPF),/Outra operação está em andamento/);
    answer.resolve({response:0});
    assert.equal((await cleaning).cancelled,true);
    assert.equal((await invoke('api:query',CPF)).state,'pending');
  },{showMessageBox:()=>{entered.resolve();return answer.promise;},maintenance:async()=>({deletedRecords:0,deletedPdfs:0,missingPdfs:0})});
});

test('caracterização: encerramento recusa novas operações e as libera se o encerramento falhar antes do banco',()=>{
  const held=heldQuery(),warning=deferred();
  return withMainProcess(held.submit,async({invoke,requestQuit,hasQuit})=>{
    const query=invoke('api:query',CPF);
    await held.entered.promise;
    requestQuit();
    await assert.rejects(invoke('history:list'),/encerramento/);
    await warning.promise;
    assert.equal(hasQuit(),false);
    assert.ok(Array.isArray(await invoke('history:list')),'operações voltam a ser aceitas');
    held.release.resolve();await query;
  },{shutdownTimeoutMs:5,showMessageBox:async()=>{warning.resolve();return {response:0};}});
});

test('caracterização: cancelamento (cpi:close) durante a varredura libera a exclusividade para a próxima operação',()=>{
  const entered=deferred(),scan=deferred();
  return withMainProcess(pending,async({invoke})=>{
    await invoke('cpi:auto:start',30);
    await entered.promise;
    const closing=invoke('cpi:close');
    await nextTurn();
    scan.resolve();await closing;
    assert.equal((await invoke('api:query',CPF)).state,'pending');
  },{cpiOpen:true,filter:async()=>{entered.resolve();await scan.promise;return {state:'empty',total:0,typeId:'29'};}});
});

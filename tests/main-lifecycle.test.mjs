import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { withMainProcess } from './helpers/main-process.mjs';

const CPF='52998224725';
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
async function until(check){for(let i=0;i<100;i++){if(check())return;await nextTurn();}throw new Error('Condição de teste não atingida');}
const pending=async(_cpf,onCode)=>{await onCode('Q-AAAAAAAAAA');return {state:'pending',queryCode:'Q-AAAAAAAAAA'};};

for(const channel of ['api:query','pis:query','company:query']){
  test(`${channel}: duas solicitações simultâneas aceitam somente uma operação`,()=>{
    let posts=0;
    return withMainProcess(async(...args)=>{
      posts++;
      if(channel==='pis:query'){
        await args[1]('Q-AAAAAAAAAA');
        return {payload:{status:{code:4000},data:{basic:{tax_id:{number:CPF}}}},queryCode:'Q-AAAAAAAAAA'};
      }
      return pending(...args);
    },async({invoke})=>{
      const result=await Promise.allSettled([invoke(channel,channel==='company:query'?'11222333000181':CPF),invoke(channel,channel==='company:query'?'11222333000181':CPF)]);
      assert.equal(result.filter(item=>item.status==='rejected').length,1);
      assert.equal(posts,1);
    });
  });
}

test('falhas antes e depois da aquisição não deixam exclusividade presa',()=>{
  let fail=true,posts=0;
  return withMainProcess(async(...args)=>{posts++;return pending(...args);},async({invoke})=>{
    await assert.rejects(invoke('api:query','invalido'));
    await assert.rejects(invoke('api:query',CPF),/saldo simulado/);
    fail=false;
    assert.equal((await invoke('api:query',CPF)).state,'pending');
    assert.equal(posts,1);
  },{credits:async()=>{if(fail)throw new Error('saldo simulado');return 20;}});
});

test('shutdown durante POST mantém sessão e persiste código antes de fechar SQLite',()=>{
  const entered=deferred(),response=deferred();
  return withMainProcess(async(cpf,onCode)=>{entered.resolve();await response.promise;return pending(cpf,onCode);},async({invoke,requestQuit,events,hasQuit,allWindowsClosed,reopenHistory})=>{
    const query=invoke('api:query',CPF);
    await entered.promise;
    requestQuit();
    allWindowsClosed();
    await nextTurn();
    assert.equal(events.includes('database_close'),false);
    assert.equal(events.includes('session_reset'),false);
    const rejected=assert.rejects(invoke('api:query','11144477735'),/encerramento|encerrando/i);
    response.resolve();
    await query;await rejected;
    await until(hasQuit);
    assert.ok(events.indexOf('code_persisted')<events.indexOf('database_close'));
    assert.ok(events.indexOf('code_persisted')<events.indexOf('session_reset'));
    assert.equal(events.includes('query_watch'),false);
    const [stored]=await reopenHistory();
    assert.equal(stored.queryCode,'Q-AAAAAAAAAA');assert.equal(stored.status,'pending');
  });
});

test('timeout de shutdown mantém banco e sessão; operação tardia persiste e nova tentativa encerra',()=>{
  const entered=deferred(),response=deferred(),warning=deferred();
  return withMainProcess(async(cpf,onCode)=>{entered.resolve();await response.promise;return pending(cpf,onCode);},async({invoke,requestQuit,events,hasQuit})=>{
    const query=invoke('api:query',CPF);await entered.promise;requestQuit();
    await warning.promise;
    assert.equal(hasQuit(),false);
    assert.equal(events.includes('database_close'),false);assert.equal(events.includes('session_reset'),false);
    await assert.rejects(invoke('api:query','11144477735'),/operação|execução/i);
    response.resolve();await query;
    assert.equal((await invoke('history:list'))[0].queryCode,'Q-AAAAAAAAAA');
    requestQuit();await until(hasQuit);
  },{shutdownTimeoutMs:5,showMessageBox:async(_window,message)=>{
    assert.match(message.detail,/incerto/);warning.resolve();return {response:0};
  }});
});

test('POST com resultado incerto durante saída conserva reserva sem código após reinício',()=>{
  const entered=deferred(),response=deferred();
  return withMainProcess(async()=>{entered.resolve();await response.promise;throw new Error('Resultado externo incerto; não repetir POST');},async({invoke,requestQuit,hasQuit,reopenHistory})=>{
    const query=invoke('api:query',CPF);await entered.promise;requestQuit();
    const failed=assert.rejects(query,/incerto/);response.resolve();await failed;
    await until(hasQuit);
    const [stored]=await reopenHistory();
    assert.equal(stored.status,'uncertain');assert.equal(stored.queryCode,undefined);assert.deepEqual(stored.pdfPaths,[]);
  });
});

test('falha ao fechar banco mantém admissão bloqueada até nova tentativa de saída',()=>{
  const warning=deferred();
  return withMainProcess(pending,async({invoke,requestQuit,hasQuit})=>{
    await invoke('api:query',CPF);requestQuit();await warning.promise;
    assert.equal(hasQuit(),false);
    await assert.rejects(invoke('history:list'),/encerramento/);
    requestQuit();await until(hasQuit);
  },{failDatabaseCloseOnce:true,showMessageBox:async(_window,message)=>{
    assert.match(message.detail,/bloqueadas/);warning.resolve();return {response:0};
  }});
});

test('pausar aguarda ciclo iniciado; retomar e fechar não deixam agendamento ou deadlock',()=>{
  const entered=deferred(),scan=deferred();let scans=0;
  return withMainProcess(pending,async({invoke})=>{
    await invoke('cpi:auto:start',30);await entered.promise;
    const paused=invoke('cpi:auto:pause');
    await assert.rejects(invoke('cpi:auto:start',30),/operação|execução/i);
    scan.resolve();assert.equal((await paused).phase,'paused');
    await invoke('cpi:auto:start',30);
    await invoke('cpi:close');
    assert.equal((await invoke('cpi:auto:status')).phase,'paused');assert.equal(scans,2);
  },{cpiOpen:true,filter:async()=>{
    scans++;if(scans===1){entered.resolve();await scan.promise;}
    return {state:'empty',total:0,typeId:'29'};
  }});
});

test('limpeza com FULL AUTO ativo é rejeitada antes de confirmar ou excluir',()=>{
  let cleans=0,dialogs=0;
  return withMainProcess(pending,async({invoke})=>{
    await invoke('cpi:auto:start',30);
    await nextTurn();
    await assert.rejects(invoke('maintenance:clean',{history:true,pdfs:false}),/CPI|automação|agente/i);
    assert.equal(cleans,0);assert.equal(dialogs,0);
    await invoke('cpi:auto:pause');
  },{cpiOpen:true,showMessageBox:async()=>{dialogs++;return {response:1};},maintenance:async()=>{cleans++;return {deletedRecords:0,deletedPdfs:0,missingPdfs:0};}});
});

test('diálogo de manutenção reserva a operação e bloqueia início de ciclo até cancelar',()=>{
  const confirming=deferred(),answer=deferred();let cleans=0;
  return withMainProcess(pending,async({invoke})=>{
    const cleaning=invoke('maintenance:clean',{history:true,pdfs:false});
    await confirming.promise;
    const rejected=assert.rejects(invoke('cpi:auto:start',30),/operação|manutenção|conclua/i);
    answer.resolve({response:0});
    await rejected;
    assert.equal((await cleaning).cancelled,true);assert.equal(cleans,0);
    await invoke('cpi:auto:start',30);await invoke('cpi:auto:pause');
  },{cpiOpen:true,showMessageBox:()=>{confirming.resolve();return answer.promise;},maintenance:async()=>{cleans++;}});
});

test('shutdown durante confirmação cancela exclusão mesmo se o usuário confirmar',()=>{
  const confirming=deferred(),answer=deferred();let cleans=0;
  return withMainProcess(pending,async({invoke,requestQuit,hasQuit})=>{
    const cleaning=invoke('maintenance:clean',{history:true,pdfs:false});
    await confirming.promise;
    requestQuit();
    const rejected=assert.rejects(cleaning,/encerramento|encerrando/i);
    answer.resolve({response:1});await rejected;
    await until(hasQuit);assert.equal(cleans,0);
  },{showMessageBox:()=>{confirming.resolve();return answer.promise;},maintenance:async()=>{cleans++;return {deletedRecords:0,deletedPdfs:0,missingPdfs:0};}});
});

test('início CPI aguardando autorização revalida a reserva feita pela manutenção',()=>{
  let armed=false,cleans=0;
  const approving=deferred(),approved=deferred(),confirming=deferred(),answer=deferred();
  return withMainProcess(pending,async({invoke})=>{
    armed=true;
    const starting=invoke('cpi:auto:start',30);await approving.promise;
    const cleaning=invoke('maintenance:clean',{history:true,pdfs:false});await confirming.promise;
    const rejected=assert.rejects(starting,/operação|manutenção/i);
    approved.resolve();await rejected;
    answer.resolve({response:0});assert.equal((await cleaning).cancelled,true);
    assert.equal((await invoke('cpi:auto:status')).phase,'stopped');assert.equal(cleans,0);
  },{cpiOpen:true,beforeApproval:async()=>{if(armed){approving.resolve();await approved.promise;}},
    showMessageBox:()=>{confirming.resolve();return answer.promise;},maintenance:async()=>{cleans++;}});
});

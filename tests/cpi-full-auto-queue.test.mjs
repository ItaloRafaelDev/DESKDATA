import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CpiWorkflowStore } from '../src/main/cpi/workflow-store.ts';
import { CpiQueueSelector, CPI_DEFER_FIRST_MS, CPI_DEFER_MAX_MS } from '../src/main/cpi/queue-selection.ts';
import { classifyCpiError, CPI_IMMEDIATE_STOP } from '../src/main/cpi/failure-classes.ts';
import { withMainProcess } from './helpers/main-process.mjs';

const protector={isAvailable:async()=>true,encrypt:async text=>Buffer.from(text),decrypt:async buf=>({result:buf.toString()})};
const ACCOUNT='ipc-tests@example.invalid';
const ids=(n)=>({pesquisaId:String(573000+n),solicitacaoId:String(275000+n)});

// Obrigatório E2: o mesmo item nunca é processado duas vezes, inclusive após reinício.
test('itens finais ou em revisão nunca são reabertos, inclusive após reinício do aplicativo',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'deskdata-cpi-queue-'));
  try{
    const rows=[ids(1),ids(2),ids(3),ids(4),ids(5)];
    let store=new CpiWorkflowStore(dir,protector);
    for(const [n,stage] of [[1,'completed'],[2,'review_required'],[3,'submit_started'],[4,'verification_required']]){
      await store.claim(ACCOUNT,ids(n));
      if(stage==='verification_required'){await store.mark(ACCOUNT,ids(n),'submit_started');}
      await store.mark(ACCOUNT,ids(n),stage);
    }
    let selector=new CpiQueueSelector();
    const first=selector.select(rows,await store.stages(ACCOUNT,rows));
    assert.deepEqual(first,{ids:ids(5),finalCount:4,deferredCount:0});
    await store.claim(ACCOUNT,ids(5));await store.mark(ACCOUNT,ids(5),'completed');
    assert.deepEqual(selector.select(rows,await store.stages(ACCOUNT,rows)),{finalCount:5,deferredCount:0});
    // Reinício: nova instância da fila (sem cache) e do seletor (sem memória de adiamento).
    store=new CpiWorkflowStore(dir,protector);selector=new CpiQueueSelector();
    assert.deepEqual(selector.select(rows,await store.stages(ACCOUNT,rows)),{finalCount:5,deferredCount:0});
    // Outra conta não herda o estado (isolamento por conta).
    assert.equal(selector.select(rows,await store.stages('outra@example.invalid',rows)).ids.pesquisaId,ids(1).pesquisaId);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('item aguardando a Deskdata é adiado com recuo (60 s → 10 min) e liberado ao concluir',()=>{
  let now=0;const selector=new CpiQueueSelector(()=>now);
  const rows=[ids(1),ids(2)];
  selector.defer(ids(1));
  assert.deepEqual(selector.select(rows,[]),{ids:ids(2),finalCount:0,deferredCount:1});
  selector.defer(ids(2));
  assert.deepEqual(selector.select(rows,[]),{finalCount:0,deferredCount:2});
  now=CPI_DEFER_FIRST_MS;
  assert.deepEqual(selector.select(rows,[]).ids,ids(1));
  for(let i=0;i<10;i++){selector.defer(ids(1));}
  now+=CPI_DEFER_MAX_MS-1;assert.equal(selector.select([ids(1)],[]).ids,undefined);
  now+=1;assert.deepEqual(selector.select([ids(1)],[]).ids,ids(1));
  selector.release(ids(1));selector.release(ids(2));
  assert.equal(selector.deferredSize,0);
});

test('classificação de falhas: condições sistêmicas de D1 param na hora; demais vão para revisão',()=>{
  const cases=[
    ['Sessão não autenticada ou expirada. Entre novamente.','deskdata_session'],
    ['Créditos insuficientes para a consulta.','balance'],
    ['Saldo Deskdata zerado; automação pausada até haver créditos disponíveis.','balance'],
    ['Autorize novas consultas Deskdata para esta conta em Minha conta.','balance'],
    ['Abra e autentique primeiro o navegador CPI.','cpi_session'],
    ['Sessão CPI inválida ou redirecionamento inesperado.','cpi_session'],
    ['O detalhe da CPI nao foi reconhecido (x). Nenhuma consulta ou envio foi executado.','portal_layout'],
    ['Etapa filtro CPI 29: total nao confirmado no portal.','portal_layout'],
    ['Fila CPI corrompida; processamento bloqueado para evitar duplicação.','storage'],
    ['Conta Deskdata alterada durante o processamento CPI.','account_changed'],
    ['Tempo limite de resposta. Não repita automaticamente: a consulta pode ter sido recebida e cobrada.','timeout'],
    ['Falha de rede durante a consulta. A requisição pode ter sido recebida: não repita automaticamente.','network'],
    ['CPF ausente ou inválido no formulário da CPI.','item_data'],
    ['Histórico não corresponde à identidade e à conta da CPI.','item_data'],
    ['Gerador indisponível','unknown']
  ];
  for(const [message,kind] of cases)assert.equal(classifyCpiError(new Error(message)),kind,message);
  assert.equal(classifyCpiError(Object.assign(new Error('waiting for locator'),{name:'TimeoutError'})),'timeout');
  // A causa preservada pelo processo principal decide a classe de um erro genérico de etapa.
  const wrapped=new Error('Etapa filtro CPI 29: falha ao atualizar a listagem.',{cause:new Error('Abra e autentique primeiro o navegador CPI.')});
  assert.equal(classifyCpiError(wrapped),'cpi_session');
  assert.equal(classifyCpiError('texto'),'unknown');
  for(const kind of ['cpi_session','deskdata_session','balance','portal_layout','storage','account_changed'])assert.ok(CPI_IMMEDIATE_STOP.has(kind));
  for(const kind of ['timeout','network','item_data','unknown','submit_unverified'])assert.ok(!CPI_IMMEDIATE_STOP.has(kind));
});

async function waitFor(predicate,ms=8000){
  const deadline=Date.now()+ms;
  while(!(await predicate())){
    if(Date.now()>deadline)throw new Error('Condição não atingida no prazo do teste.');
    await new Promise(resolve=>setTimeout(resolve,20));
  }
}

// Obrigatório E2 (fim a fim no processo principal): falha de item não interrompe os itens seguintes.
test('processo principal: falha de item vai para revisão, o próximo item é aberto e itens finais não são reabertos',()=>{
  const opened=[];
  const rows=[ids(1),ids(2),ids(3)];
  return withMainProcess(async()=>{throw new Error('POST indevido');},async({invoke,root,diagnostics})=>{
    const store=new CpiWorkflowStore(root,protector);
    await store.claim(ACCOUNT,ids(1));await store.mark(ACCOUNT,ids(1),'completed');
    await invoke('cpi:auto:start',300);
    await waitFor(async()=>(await invoke('cpi:auto:status')).counters.review>=2);
    const state=await invoke('cpi:auto:pause');
    assert.deepEqual(opened,[ids(2),ids(3)],'o item concluído não é reaberto e cada item é aberto uma única vez');
    assert.equal(state.phase,'paused');
    assert.deepEqual(state.counters,{completed:0,review:2,failures:2,pending:0});
    const reloaded=new CpiWorkflowStore(root,protector);
    assert.deepEqual(await reloaded.stages(ACCOUNT,rows),['completed','review_required','review_required']);
    const outcomes=diagnostics.filter(entry=>entry.event==='timing_cycle').map(entry=>entry.outcome);
    assert.ok(outcomes.filter(value=>value==='item_failed').length>=2);
    assert.doesNotMatch(JSON.stringify(diagnostics)+JSON.stringify(state),/52998224725/);
  },{cpiOpen:true,
    filter:async()=>({state:'found',total:rows.length,typeId:'29'}),
    rows:async()=>({state:'mapped',total:rows.length,visibleRows:rows.length,rows,framesInspected:1,message:''}),
    details:async target=>{opened.push(target);},
    readCpf:()=>{throw new Error('CPF ausente ou inválido no formulário da CPI.');}});
});

test('processo principal: sessão CPI expirada na listagem pausa o agente na primeira ocorrência',()=>{
  let filters=0;
  return withMainProcess(async()=>{throw new Error('POST indevido');},async({invoke})=>{
    await invoke('cpi:auto:start',300);
    await waitFor(async()=>(await invoke('cpi:auto:status')).phase==='error');
    const state=await invoke('cpi:auto:status');
    assert.equal(filters,1);
    assert.match(state.lastMessage,/sessão CPI/);
    assert.deepEqual(state.failureStreak,{kind:'cpi_session',count:1});
  },{cpiOpen:true,filter:async()=>{filters++;throw new Error('Abra e autentique primeiro o navegador CPI.');}});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { CpiFullAutoRunner, abortableSleep, nextIdleDelaySeconds, safeCpiCycleError } from '../src/main/cpi/full-auto-runner.ts';

const T0=Date.parse('2026-11-12T12:00:00Z');
const ids=(n)=>({pesquisaId:String(573000+n),solicitacaoId:String(275000+n)});
const outcome=(n,state,extra={})=>({...ids(n),state,message:'ok',...extra});
const idle={kind:'idle',found:0};

/**
 * Relógio virtual: cada espera avança o tempo e resolve no próximo turno. Ao passar do horizonte, a espera
 * só termina por cancelamento (pausa) e sinaliza `reached`. Os testes nunca dependem de tempo real.
 */
function virtualClock(horizonSeconds=Infinity){
  let now=T0,reached;const sleeps=[],done=new Promise(resolve=>{reached=resolve;});
  return {sleeps,done,now:()=>now,elapsed:()=>(now-T0)/1000,
    sleep:(ms,signal)=>new Promise(resolve=>{
      sleeps.push(ms/1000);
      if(now+ms>T0+horizonSeconds*1000){
        reached();
        if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});
        return;
      }
      now+=ms;setImmediate(resolve);
    })};
}
function runnerWith(scan,clock,updates=[]){return new CpiFullAutoRunner(scan,state=>updates.push(state),{sleep:clock.sleep,now:clock.now});}

test('início valida o teto de espera e nenhuma varredura ocorre antes de iniciar',async()=>{
  let calls=0;const clock=virtualClock(0);
  const run=runnerWith(async()=>{calls++;return idle;},clock);
  assert.equal(calls,0);
  await assert.rejects(run.start(1),/Intervalo/);
  assert.equal(calls,0);
  await run.start(60);
  await clock.done;
  await run.pause();
  assert.equal(calls,1);
  assert.equal(run.status().phase,'paused');
  assert.equal(run.isActive(),false);
});

// Obrigatório E2: fila vazia não gera mais que N consultas ao portal por intervalo.
test('fila vazia: recuo 30 s → 5 min, no máximo 15 consultas ao portal por hora e nunca espera ativa',async()=>{
  const scans=[];const clock=virtualClock(3600);
  const run=runnerWith(async()=>{scans.push(clock.elapsed());return idle;},clock);
  await run.start(300);
  await clock.done;
  await run.pause();
  assert.deepEqual(clock.sleeps.slice(0,6),[30,60,120,240,300,300]);
  assert.ok(clock.sleeps.every(seconds=>seconds>=30),'nenhuma espera menor que 30 s com fila vazia');
  assert.ok(scans.length<=15,`consultas na primeira hora: ${scans.length}`);
  for(let i=5;i<scans.length;i++)assert.ok(scans[i]-scans[i-1]>=300,'após o aquecimento, no máximo uma consulta a cada 5 min');
  assert.equal(run.status().phase,'paused');
});

test('teto menor que 5 min é respeitado e a espera recomeça em 30 s quando aparece uma pesquisa',async()=>{
  let call=0;const clock=virtualClock(1000);
  const run=runnerWith(async()=>++call===4?{kind:'item',found:1,outcome:outcome(1,'completed')}:idle,clock);
  await run.start(60);
  await clock.done;await run.pause();
  assert.deepEqual(clock.sleeps.slice(0,6),[30,60,60,2,30,60]);
  assert.equal(nextIdleDelaySeconds(null,300),30);
  assert.equal(nextIdleDelaySeconds(240,300),300);
});

// Obrigatório E2: falha de item não interrompe os itens seguintes.
test('falha de item vai para revisão e o agente segue para os próximos itens',async()=>{
  const results=[
    {kind:'item_failed',found:3,ids:ids(1),failure:'item_data',message:'CPF ausente ou inválido no formulário da CPI.'},
    {kind:'item',found:2,outcome:outcome(2,'completed')},
    {kind:'item',found:1,outcome:outcome(3,'review_required')},
    {kind:'item',found:1,outcome:outcome(4,'completed',{warnings:['auxiliary_404','modal_open']})}
  ];
  let calls=0;const clock=virtualClock(10);
  const run=runnerWith(async()=>results[calls++]??idle,clock);
  await run.start(300);
  await clock.done;await run.pause();
  assert.equal(calls,5);
  assert.deepEqual(clock.sleeps.slice(0,4),[2,2,2,2]);
  assert.deepEqual(run.status().counters,{completed:2,review:2,failures:1,pending:0});
  assert.equal(run.status().failureStreak,null);
});

// Obrigatório E2: 3 falhas sistêmicas consecutivas pausam o agente.
test('3 falhas consecutivas da mesma classe pausam o agente; classe diferente reinicia a contagem',async()=>{
  const errors=['Tempo limite excedido na CPI','Tempo limite excedido na CPI','Falha de rede ao abrir a CPI',
    'Tempo limite excedido na CPI','Tempo limite excedido na CPI','Tempo limite excedido na CPI'];
  let calls=0;const clock=virtualClock();
  const run=runnerWith(async()=>{throw new Error(errors[calls++]);},clock);
  await run.start(300);
  while(run.isActive())await nextTurn();
  assert.equal(calls,6);
  const state=run.status();
  assert.equal(state.phase,'error');
  assert.deepEqual(state.failureStreak,{kind:'timeout',count:3});
  assert.equal(state.counters.failures,6);
  assert.match(state.lastMessage,/3 falhas consecutivas: tempo limite/);
  await run.pause();
  assert.equal(run.status().phase,'error','a pausa posterior preserva a mensagem da parada sistêmica');
});

test('falhas de item da mesma classe também contam: 3 seguidas pausam sem abrir o 4º item',async()=>{
  let calls=0;const clock=virtualClock();
  const run=runnerWith(async()=>{calls++;return {kind:'item_failed',found:9,ids:ids(calls),failure:'unknown',message:'Falha simulada.'};},clock);
  await run.start(300);
  while(run.isActive())await nextTurn();
  assert.equal(calls,3);
  assert.equal(run.status().phase,'error');
  assert.equal(run.status().counters.review,3);
});

test('3 envios sem confirmação seguidos pausam o agente (sem reenvio)',async()=>{
  let calls=0;const clock=virtualClock();
  const run=runnerWith(async()=>({kind:'item',found:9,outcome:outcome(++calls,'verification_required')}),clock);
  await run.start(300);
  while(run.isActive())await nextTurn();
  assert.equal(calls,3);
  assert.deepEqual(run.status().failureStreak,{kind:'submit_unverified',count:3});
});

for(const message of ['Saldo Deskdata zerado; automação pausada até haver créditos disponíveis.',
  'Sessão não autenticada ou expirada. Entre novamente.','Abra e autentique primeiro o navegador CPI.',
  'Etapa leitura CPI: identificadores da listagem nao confirmados.','Fila CPI corrompida; processamento bloqueado para evitar duplicação.']){
  test(`condição sistêmica para na primeira ocorrência: ${message.slice(0,40)}`,async()=>{
    let calls=0;const clock=virtualClock();
    const run=runnerWith(async()=>{calls++;throw new Error(message);},clock);
    await run.start(300);
    while(run.isActive())await nextTurn();
    assert.equal(calls,1);
    assert.equal(run.status().phase,'error');
    assert.match(run.status().lastMessage,/sem reenvio automatico/);
  });
}

// Obrigatório E2: pausar durante a espera interrompe a espera.
test('pausar durante a espera cancela o temporizador imediatamente (espera real de 1 h)',async()=>{
  let calls=0;
  const run=new CpiFullAutoRunner(async()=>{calls++;return idle;},()=>{},{sleep:abortableSleep});
  await run.start(3600);
  while(run.status().phase!=='waiting')await nextTurn();
  const started=performance.now();
  await run.pause();
  assert.ok(performance.now()-started<500,'a pausa não aguarda o fim da espera');
  assert.equal(calls,1);
  assert.equal(run.status().phase,'paused');
  assert.equal(run.status().nextCheckAt,null);
});

test('pausar durante um item conclui o item, não abre outro e o sinal fica abortado para a varredura',async()=>{
  let release,signalSeen;const gate=new Promise(resolve=>{release=resolve;});let calls=0;
  const clock=virtualClock();
  const run=runnerWith(async({signal,onItem})=>{calls++;signalSeen=signal;onItem(ids(1));await gate;return {kind:'item',found:2,outcome:outcome(1,'completed')};},clock);
  await run.start(300);
  while(!run.status().currentItem)await nextTurn();
  assert.deepEqual(run.status().currentItem,ids(1));
  const pausing=run.pause();
  await nextTurn();
  assert.equal(signalSeen.aborted,true);
  release();
  await pausing;
  assert.equal(calls,1);
  assert.equal(run.status().phase,'paused');
  assert.equal(run.status().counters.completed,1);
  assert.equal(run.status().currentItem,null);
});

test('abortableSleep resolve no prazo e imediatamente quando já abortado',async()=>{
  const controller=new AbortController();
  await abortableSleep(5,controller.signal);
  controller.abort();
  const started=performance.now();await abortableSleep(60_000,controller.signal);
  assert.ok(performance.now()-started<100);
});

test('snapshot expõe somente códigos CPI, contadores e duração do ciclo',async()=>{
  const clock=virtualClock(5),updates=[];
  const run=runnerWith(async({onItem})=>{onItem(ids(7));return {kind:'item',found:1,outcome:outcome(7,'completed')};},clock,updates);
  await run.start(300);
  await clock.done;await run.pause();
  const running=updates.find(state=>state.currentItem);
  assert.deepEqual(running.currentItem,ids(7));
  assert.ok(running.cycleStartedAt);
  assert.equal(typeof run.status().lastCycleMs,'number');
  assert.deepEqual(Object.keys(run.status()).sort(),['checks','counters','currentItem','cycleStartedAt','failureStreak','intervalSeconds','lastCycleMs','lastMessage','nextCheckAt','phase']);
});

test('exibe motivo da falha sem mostrar CPF ou URL', () => {
  assert.doesNotMatch(safeCpiCycleError(new Error('CPF 123.456.789-09 na URL https://example.com/teste')), /123|example.com/);
  assert.match(safeCpiCycleError(new Error('CPF 123.456.789-09 na URL https://example.com/teste')), /\[CPF\]|\[URL\]/);
});

test('ensaio: um item dry_run pausa o agente com a mensagem do ensaio, sem contar conclusão nem falha',async()=>{
  let calls=0;const clock=virtualClock(600);
  const run=runnerWith(async()=>{calls++;return {kind:'item',found:2,outcome:outcome(1,'dry_run',{message:'Ensaio concluído (Há Informações): campos preenchidos e PDF anexado; nada foi salvo.'})};},clock);
  await run.start(60);
  while(run.isActive())await nextTurn();
  const status=run.status();
  assert.equal(calls,1);assert.equal(status.phase,'paused');
  assert.match(status.lastMessage,/Ensaio concluído.*Agente pausado após o ensaio/);
  assert.deepEqual(status.counters,{completed:0,review:0,failures:0,pending:0});
});

// Auditoria: persistência confirmada com janela conflitante grava a conclusão, mas não abre outra pesquisa.
test('pesquisa concluída com navegador retido (browserHold) pausa o agente na hora, sem abrir o próximo item',async()=>{
  let calls=0;const clock=virtualClock();
  const held=outcome(1,'completed',{warnings:['modal_open'],browserHold:true,message:'Resposta CPI confirmada. Avisos: a janela da pesquisa continua aberta.'});
  const run=runnerWith(async()=>{calls++;return calls===1?{kind:'item',found:2,outcome:held}:{kind:'item',found:1,outcome:outcome(2,'completed')};},clock);
  await run.start(300);
  while(run.isActive())await nextTurn();
  assert.equal(calls,1,'nenhuma varredura depois da retenção');
  const state=run.status();
  assert.equal(state.phase,'error');assert.equal(state.counters.completed,1);
  assert.deepEqual(state.failureStreak,{kind:'cpi_operational',count:1});
  assert.match(state.lastMessage,/Automação pausada: feche a janela da pesquisa/);
  assert.match(state.lastMessage,/nada será reenviado/);
});

test('verificação manual com navegador retido também pausa na hora',async()=>{
  let calls=0;const clock=virtualClock();
  const run=runnerWith(async()=>{calls++;return {kind:'item',found:1,outcome:outcome(1,'verification_required',{browserHold:true})};},clock);
  await run.start(300);
  while(run.isActive())await nextTurn();
  assert.equal(calls,1);assert.equal(run.status().phase,'error');assert.equal(run.status().counters.review,1);
});

test('pendência operacional do navegador é parada imediata, inclusive encapsulada pela etapa do filtro',async()=>{
  const { classifyCpiError, CPI_IMMEDIATE_STOP } = await import('../src/main/cpi/failure-classes.ts');
  const hold=new Error('Pendência operacional CPI: resposta confirmada na CPI, mas a janela da pesquisa continua aberta. Feche a janela manualmente na CPI antes de continuar; nenhuma pesquisa será aberta até lá.');
  assert.equal(classifyCpiError(hold),'cpi_operational');
  assert.equal(classifyCpiError(new Error('Etapa filtro CPI 29: falha ao atualizar a listagem.',{cause:hold})),'cpi_operational');
  assert.ok(CPI_IMMEDIATE_STOP.has('cpi_operational'));
  let calls=0;const clock=virtualClock();
  const run=runnerWith(async()=>{calls++;throw new Error('Etapa filtro CPI 29: falha ao atualizar a listagem.',{cause:hold});},clock);
  await run.start(300);
  while(run.isActive())await nextTurn();
  assert.equal(calls,1);assert.equal(run.status().phase,'error');
  assert.match(run.status().lastMessage,/janela CPI aberta após envio/);
});

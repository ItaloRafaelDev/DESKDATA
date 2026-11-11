import test from 'node:test';
import assert from 'node:assert/strict';
import { CpiFullAutoRunner, nextFullAutoDelaySeconds } from '../src/main/cpi/full-auto-runner.ts';

test('intervalo deve ser validado e nenhuma varredura ocorre antes de iniciar',async()=>{
 let calls=0;
 const run=new CpiFullAutoRunner(async()=>{calls++;return {found:0,outcomes:[]};});
 assert.equal(calls,0);
 await assert.rejects(run.start(1),/Intervalo/);
 assert.equal(calls,0);
 await run.start(60);
 await run.pause();
 assert.equal(calls,1);
 assert.equal(run.status().phase,'paused');
});
test('erro na operação pausa o ciclo sem repetição automática',async()=>{
 let calls=0;
 const run=new CpiFullAutoRunner(async()=>{calls++;throw Error('falha de upload');});
 await run.start(30);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(run.status().phase,'error');
 assert.equal(calls,1);
});

test('apos sucesso com solicitacoes restantes prossegue em 2 segundos, sem sobrepor o monitor',()=>{
 const success={state:'completed',pesquisaId:'573987',solicitacaoId:'275064',message:'ok'};
 const failure={...success,state:'verification_required'};
 assert.equal(nextFullAutoDelaySeconds(60,4,[success]),2);
 assert.equal(nextFullAutoDelaySeconds(60,1,[success]),60);
 assert.equal(nextFullAutoDelaySeconds(60,4,[failure]),60);
 assert.equal(nextFullAutoDelaySeconds(60,0,[]),60);
});


test('CPI concluida com aviso de recurso auxiliar ainda conta como concluida e segue fila',async()=>{
 const item={state:'completed',pesquisaId:'538825',solicitacaoId:'275530',warning:'auxiliary_404',message:'CPI salva, 404 auxiliar'};
 const runner=new CpiFullAutoRunner(async()=>({found:3,outcomes:[item]}));
 await runner.start(30);
 await runner.pause();
 assert.equal(runner.status().processed,1);
 assert.match(runner.status().lastMessage,/404|Pausado/);
 assert.equal(nextFullAutoDelaySeconds(60,3,[item]),2);
});

test('exibe motivo da falha sem mostrar CPF ou URL, e nao tenta novamente', async () => {
  const { safeCpiCycleError } = await import('../src/main/cpi/full-auto-runner.ts');
  assert.doesNotMatch(safeCpiCycleError(new Error('CPF 123.456.789-09 na URL https://example.com/teste')), /123|example.com/);
  assert.match(safeCpiCycleError(new Error('CPF 123.456.789-09 na URL https://example.com/teste')), /\[CPF\]|\[URL\]/);
  let calls = 0;
  const runner = new CpiFullAutoRunner(async () => { calls++; throw Error('Etapa leitura CPI: listagem nao confirmada'); });
  await runner.start(30);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runner.status().phase, 'error');
  assert.match(runner.status().lastMessage, /Etapa leitura CPI/);
  assert.equal(calls, 1);
});

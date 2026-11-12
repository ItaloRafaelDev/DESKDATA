import test from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationOperations, settleWithin } from '../src/main/operations.ts';

function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}

test('reserva síncrona rejeita aquisição concorrente e libera após exceção',async()=>{
  const operations=new ApplicationOperations(),gate=deferred();
  const first=operations.run(()=>gate.promise,true);
  await assert.rejects(operations.run(async()=>{},true),/operação/);
  assert.equal(operations.isExclusive(),true);
  gate.resolve();await first;
  await assert.rejects(operations.run(()=>{throw new Error('falha síncrona');},true),/falha síncrona/);
  assert.equal(operations.isExclusive(),false);
  assert.equal(await operations.run(async()=>42,true),42);
});

test('shutdown rejeita novos trabalhos e timeout não libera trabalho ainda pendente',async()=>{
  const operations=new ApplicationOperations(),gate=deferred();
  const first=operations.run(()=>gate.promise,true);
  operations.stopAccepting();
  await assert.rejects(operations.run(async()=>{}),/encerramento/);
  assert.equal(await operations.waitForIdle([],5),false);
  assert.equal(operations.isExclusive(),true);
  operations.resumeAccepting();
  await assert.rejects(operations.run(async()=>{},true),/operação/);
  gate.resolve();await first;
  assert.equal(await operations.waitForIdle([],5),true);
});

test('drenagem aguarda trabalhos compartilhados, falhas e parada externa',async()=>{
  const operations=new ApplicationOperations(),shared=deferred(),stop=deferred();
  const first=operations.run(()=>shared.promise);
  const failed=operations.run(async()=>{throw new Error('falha');});
  await assert.rejects(failed,/falha/);
  operations.stopAccepting();
  shared.resolve();await first;
  assert.equal(await operations.waitForIdle([stop.promise],5),false);
  stop.resolve();assert.equal(await operations.waitForIdle([stop.promise],5),true);
  await assert.rejects(settleWithin(Promise.reject(new Error('recurso indisponível')),5),/recurso/);
});

test('reserva exclusiva durante preparação bloqueia nova varredura e espera a anterior terminar',async()=>{
  const operations=new ApplicationOperations(),active=deferred(),prepare=deferred();
  const order=[];
  const first=operations.run(async()=>{await active.promise;order.push('varredura');},true);
  const stopping=operations.runExclusiveAfter(async()=>{await prepare.promise;},async()=>{order.push('fechamento');});
  assert.equal(operations.isExclusive(),true);
  await assert.rejects(operations.run(async()=>{order.push('nova varredura');},true),/operação/);
  await assert.rejects(operations.runExclusiveAfter(async()=>{},async()=>{}),/operação/);
  prepare.resolve();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(order,[]);
  active.resolve();
  await first;await stopping;
  assert.deepEqual(order,['varredura','fechamento']);
  assert.equal(operations.isExclusive(),false);
});

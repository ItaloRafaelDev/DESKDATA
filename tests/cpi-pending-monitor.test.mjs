import test from 'node:test';
import assert from 'node:assert/strict';
import { CpiPendingMonitor, validateCpiMonitorInterval } from '../src/main/cpi/pending-monitor.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const empty = {typeId:'29',total:0,state:'empty'};
const found = {typeId:'29',total:3,state:'found'};

test('CPI monitor: exige intervalo seguro', () => {
  for (const valid of [30, 45, 60, 3601, 7200, 86400]) {
    assert.equal(validateCpiMonitorInterval(valid), valid);
  }
  for (const invalid of [0, 29, 86401, 30.5, NaN, Infinity, '60']) {
    assert.throws(() => validateCpiMonitorInterval(invalid));
  }
});

test('CPI monitor: primeira verificação vazia agenda o ciclo seguinte sem consultar pessoas', async () => {
  let polls = 0;
  const monitor = new CpiPendingMonitor(async () => { polls++; return empty; });
  monitor.start(60);
  await tick();
  const result = monitor.status();
  assert.equal(result.phase, 'waiting');
  assert.equal(result.lastTotal, 0);
  assert.equal(result.checks, 1);
  assert.ok(result.nextCheckAt);
  assert.equal(polls, 1);
  await monitor.stopAndWait();
  assert.equal(monitor.status().phase, 'stopped');
});

test('CPI monitor: ocorrências positivas suspendem execução para mapeamento', async () => {
  let polls=0;
  const monitor = new CpiPendingMonitor(async () => { polls++; return found; });
  monitor.start();
  await tick();
  assert.equal(monitor.status().phase,'needs_mapping');
  assert.equal(monitor.status().lastTotal,3);
  await tick();
  assert.equal(polls,1);
  await monitor.stopAndWait();
});

test('CPI monitor: rodapé não confirmado não é interpretado como zero', async () => {
  const monitor = new CpiPendingMonitor(async()=>({typeId:'29',total:null,state:'unconfirmed'}));
  monitor.start();await tick();
  assert.equal(monitor.status().phase,'error');
  assert.equal(monitor.status().lastTotal,null);
  await monitor.stopAndWait();
});

test('CPI monitor: inconsistência total/estado interrompe', async () => {
  const monitor = new CpiPendingMonitor(async()=>({typeId:'29',total:2,state:'empty'}));
  monitor.start();await tick();
  assert.equal(monitor.status().phase,'error');
  await monitor.stopAndWait();
});

test('CPI monitor: exceção interrompe sem repetir a operação', async () => {
  let polls=0;
  const monitor = new CpiPendingMonitor(async()=>{polls++;throw new Error('Sessão expirada');});
  monitor.start();await tick();
  assert.equal(monitor.status().phase,'error');
  assert.equal(monitor.status().lastTotal,null);
  assert.equal(polls,1);
  await monitor.stopAndWait();
});

test('CPI monitor: pausa durante uma verificação não agenda outra', async () => {
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  let polls=0;
  const monitor = new CpiPendingMonitor(async()=>{polls++;await gate;return empty;});
  monitor.start();await tick();
  monitor.pause();
  release();
  await tick();
  assert.equal(monitor.status().phase,'paused');
  assert.equal(polls,1);
  await monitor.stopAndWait();
});

test('CPI monitor: inicia uma única verificação e recusa start concorrente', async () => {
  const monitor=new CpiPendingMonitor(async()=>empty);
  monitor.start();
  assert.throws(()=>monitor.start(),/andamento/);
  await tick();
  await monitor.stopAndWait();
});

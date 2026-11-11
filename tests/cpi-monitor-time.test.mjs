import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCpiMonitorIntervalInput, getCpiRemainingSeconds, formatCpiCountdown,
  CPI_MIN_INTERVAL_SECONDS, CPI_MAX_INTERVAL_SECONDS
} from '../src/shared/cpi-monitor-time.ts';

test('CPI: campo manual aceita inteiros arbitrários dentro dos limites', () => {
  for (const n of [CPI_MIN_INTERVAL_SECONDS, 45, 73, 901, 7200, CPI_MAX_INTERVAL_SECONDS]) {
    assert.equal(parseCpiMonitorIntervalInput(String(n)), n);
  }
  for (const value of ['', ' ', '-1', '0', '29', '1.5', 'abc', '1e3', '86401', '9999999999999999999999']) {
    assert.equal(parseCpiMonitorIntervalInput(value), null, value);
  }
});

test('CPI: temporizador calcula tempo restante e limita zero sem antecipar execução', () => {
  const target = '2026-11-10T12:01:00.000Z';
  const start = Date.parse('2026-11-10T12:00:00.000Z');
  assert.equal(getCpiRemainingSeconds(target, start), 60);
  assert.equal(getCpiRemainingSeconds(target, start + 10_010), 50);
  assert.equal(getCpiRemainingSeconds(target, start + 60_000), 0);
  assert.equal(getCpiRemainingSeconds(target, start + 61_000), 0);
  assert.equal(getCpiRemainingSeconds(null, start), null);
  assert.equal(getCpiRemainingSeconds('invalid', start), null);
  assert.equal(getCpiRemainingSeconds(target, NaN), null);
});

test('CPI: temporizador mostra segundos, minutos e horas', () => {
  assert.equal(formatCpiCountdown(0), '00:00');
  assert.equal(formatCpiCountdown(9), '00:09');
  assert.equal(formatCpiCountdown(65), '01:05');
  assert.equal(formatCpiCountdown(3605), '01:00:05');
  assert.equal(formatCpiCountdown(86400), '24:00:00');
  assert.equal(formatCpiCountdown(null), '--:--');
});

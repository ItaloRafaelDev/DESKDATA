import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCpiPaidBalance } from '../src/main/cpi/paid-balance.ts';

test('CPI aceita saldo positivo sem teto local de consultas', () => {
  for (const credits of [1, 6, 100, 25000]) assert.doesNotThrow(()=>assertCpiPaidBalance(credits,true));
});
test('CPI bloqueia novos POSTs sem autorização ou quando o saldo é zero', () => {
  assert.throws(()=>assertCpiPaidBalance(100,false),/autorize/i);
  assert.throws(()=>assertCpiPaidBalance(0,true),/zerado/i);
});
test('CPI bloqueia saldo inválido para não arriscar consumo', () => {
  for(const credits of [-1, 1.25, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(()=>assertCpiPaidBalance(credits,true),/inválido/i);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryRecovery } from '../src/shared/query-recovery.ts';

test('mantém resposta recebida para reprocessar sem outra solicitação à API', () => {
  const cache = new QueryRecovery();
  const payload = {status:{code:4000},data:{lawsuits:{total:1}}};
  cache.remember({cpf:'52998224725', consultedAt:'2026-10-30T10:00:00Z', queryCode:'Q-ABC123DEF4', payload});
  assert.equal(cache.exists(),true);
  assert.equal(cache.matches('52998224725'),true);
  assert.equal(cache.matches('12345678900'),false);
  assert.equal(cache.read()?.payload,payload);
  cache.clear();
  assert.equal(cache.exists(),false);
  assert.equal(cache.read(),null);
});

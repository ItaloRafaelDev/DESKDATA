import test from 'node:test';
import assert from 'node:assert/strict';
import { cpfDigits, isValidCpf, formatCpf } from '../src/shared/cpf.ts';
test('CPF válido pode vir formatado', () => {
  assert.equal(isValidCpf('529.982.247-25'), true);
  assert.equal(cpfDigits('529.982.247-25'), '52998224725');
  assert.equal(formatCpf('52998224725'), '529.982.247-25');
});
test('rejeita CPF com dígito verificador incorreto e sequências repetidas', () => {
  assert.equal(isValidCpf('52998224726'), false);
  assert.equal(isValidCpf('00000000000'), false);
  assert.equal(isValidCpf('5299822472'), false);
});

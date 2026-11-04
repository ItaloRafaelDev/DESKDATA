import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDeskdataResponse, DataContractError } from '../src/shared/normalizer.ts';
const data = { basic: {name: 'Exemplo'}, phones: {items: []}, addresses: {items: []}, emails: {items: []}, lawsuits: {items: [{sphere: 'Criminal'}]} };
test('normaliza resposta completa e diferencia vazio de sucesso', () => {
  const normalized = normalizeDeskdataResponse({status:{code:4000}, data});
  assert.equal(normalized.phones.status, 'empty');
  assert.equal(normalized.lawsuits.status, 'ok');
});
test('não permite relatório com dataset omitido', () => {
  assert.throws(()=>normalizeDeskdataResponse({status:{code:4000}, data: {...data, emails: undefined}}), DataContractError);
});
test('bloqueia dataset com erro interno', () => {
  assert.throws(()=>normalizeDeskdataResponse({status:{code:4000}, data:{...data, emails:{status:{code:4512},items:[]}}}),/emails/);
});
test('rejeita código de resposta diferente de sucesso', () => {
  assert.throws(()=>normalizeDeskdataResponse({status:{code:4008},data}),/4000/);
});
test('aceita ausência de items somente quando o total de processos é explicitamente zero', () => {
  const normalized = normalizeDeskdataResponse({status:{code:4000},data:{...data,lawsuits:{total:0,total_as_author:0}}});
  assert.equal(normalized.lawsuits.status,'empty');
  assert.deepEqual(normalized.lawsuits.value.items,[]);
  assert.equal(normalized.lawsuits.value.total,0);
});
test('não transforma ausência de items em zero processos quando o total não é conhecido', () => {
  assert.throws(()=>normalizeDeskdataResponse({status:{code:4000},data:{...data,lawsuits:{}}}),/lawsuits.*items.*ausente/);
});
test('bloqueia ausência de items quando há contagem positiva de processos', () => {
  assert.throws(()=>normalizeDeskdataResponse({status:{code:4000},data:{...data,lawsuits:{total:2}}}),/lawsuits.*items.*ausente/);
});
test('recusa items nulo mesmo com total zero', () => {
  assert.throws(()=>normalizeDeskdataResponse({status:{code:4000},data:{...data,lawsuits:{total:0,items:null}}}),/lawsuits.*items.*inválido/);
});
test('retorna diagnóstico sem valores pessoais em datasets com formato inesperado', () => {
  const privateData = {...data,lawsuits:{total:2,secret:'DADO-PESSOAL-PRIVADO'}};
  assert.throws(()=>normalizeDeskdataResponse({status:{code:4000},data:privateData}),err=>{
    assert.equal(err.name,'DataContractError');
    assert.doesNotMatch(err.message,/DADO-PESSOAL-PRIVADO/);
    assert.match(err.message,/lawsuits.*items.*ausente/);
    return true;
  });
});

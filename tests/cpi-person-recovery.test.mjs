import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareCpiPersonPdf } from '../src/main/cpi/person-recovery.ts';

const cpf = '52998224725'; // CPF sintetico para testes
const account = 'tester@example.com';
const ids = { pesquisaId: '537987', solicitacaoId: '275064' };
const createRecord = (overrides = {}) => ({
  id: '6c4978a8-3f58-44ce-adf0-96c213432111', kind: 'person', account, cpf,
  requestedAt: '2026-11-10T10:00:00.000Z', updatedAt: '2026-11-10T10:01:00.000Z',
  status: 'pending', queryCode: 'Q-ABCDEF0123', pdfPaths: [], ...overrides
});
const call = (options = {}) => {
  const findLatest = options.findLatest ?? (async () => null);
  return prepareCpiPersonPdf({ ids, account, cpf, outputFolder: '/tmp/pdf',
    recoverExisting: async () => { throw new Error('GET should not be called'); },
    ...options, findLatest });
};

test('4B: sem historico indica autorizacao; nunca tenta recuperar', async () => {
  const result = await call();
  assert.deepEqual(result, { ...ids, state: 'requires_paid_authorization', reused: false });
  assert.ok(!JSON.stringify(result).includes(cpf));
});

test('4B: consulta incompleta sem codigo nao pode criar novo POST', async () => {
  const result = await call({ findLatest: async () => createRecord({ queryCode: undefined }) });
  assert.equal(result.state, 'manual_review');
});

test('4B: pasta ausente impede tentar GET', async () => {
  const result = await call({ outputFolder: null, findLatest: async () => createRecord() });
  assert.equal(result.state, 'folder_unconfigured');
});

test('4B: consulta de outra conta e bloqueada', async () => {
  await assert.rejects(call({findLatest: async () => createRecord({ account: 'other@example.com' })}), /inconsistente/);
});

test('4B: consulta de CPF divergente e bloqueada', async () => {
  await assert.rejects(call({findLatest: async () => createRecord({ cpf: '11144477735' })}), /inconsistente/);
});

test('4B: pendencia com codigo utiliza recuperacao existente e retorna pending', async () => {
  let recovered = 0;
  const result = await call({findLatest: async () => createRecord(), recoverExisting: async row => {
    assert.equal(row.queryCode, 'Q-ABCDEF0123'); recovered++; return {state:'pending'};
  }});
  assert.equal(result.state,'pending');
  assert.equal(recovered,1);
});

test('4B: pdf da consulta mais recente pode ser reutilizado sem GET', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'cpi-4b-'));
  try {
    const path = join(folder,`RELATORIO_${cpf}_2026-11-10.pdf`);
    await writeFile(path, Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(120)]));
    const result=await call({outputFolder:folder, findLatest:async()=>createRecord({status:'ready',pdfPaths:[path]})});
    assert.equal(result.state,'pdf_ready');assert.equal(result.reused,true);
    assert.ok(!JSON.stringify(result).includes(folder));
    assert.ok(!JSON.stringify(result).includes(cpf));
  } finally { await rm(folder,{recursive:true,force:true}); }
});

test('4B: GET que confirma resultado e salva PDF e validado antes do retorno', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'cpi-4b-'));
  try {
    const path = join(folder,`RELATORIO_${cpf}_2026-11-10.pdf`);
    let record = createRecord();
    const result=await call({outputFolder:folder, findLatest:async()=>record, recoverExisting:async()=>{
      await writeFile(path,Buffer.concat([Buffer.from('%PDF-1.7\n'),Buffer.alloc(120)]));
      record=createRecord({status:'ready',pdfPaths:[path]});
      return {state:'ready'};
    }});
    assert.equal(result.state,'pdf_ready');
  } finally { await rm(folder,{recursive:true,force:true}); }
});

test('4B: GET pronto sem PDF no historico nao confirma sucesso', async () => {
  const folder=await mkdtemp(join(tmpdir(),'cpi-4b-'));
  try {
    await assert.rejects(call({outputFolder:folder,findLatest:async()=>createRecord({status:'ready'}), recoverExisting:async()=>({state:'ready'})}),/PDF correspondente/);
  } finally { await rm(folder,{recursive:true,force:true}); }
});

test('4B: troca de registro mais recente durante GET interrompe associacao', async () => {
  let read=0;
  await assert.rejects(call({findLatest:async()=>{read++;return createRecord(read>1?{id:'another-record'}:{});},recoverExisting:async()=>({state:'ready'})}),/alterado/);
});

test('4B: bloqueia identificadores invalidos antes de acessar historico', async () => {
  let calls=0;
  await assert.rejects(call({ids:{pesquisaId:'29',solicitacaoId:'err'},findLatest:async()=>{calls++;return null;}}),/invalida/);
  assert.equal(calls,0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { personPdfName, pisPdfName, companyPdfName, cpiPdfName, cpiPdfPattern, isManagedPdfName, PDF_NO_CODE } from '../src/main/pdf-names.ts';

const CPF='52998224725',CNPJ='11222333000181',code='Q-ABCDEF0123',date='2026-11-12';
const ids={pesquisaId:'537987',solicitacaoId:'275064'};

test('D2: consultas manuais usam o código da consulta Deskdata',()=>{
  assert.equal(personPdfName(code,date),'RELATORIO_Q-ABCDEF0123_2026-11-12');
  assert.equal(pisPdfName(code,date),'PIS_Q-ABCDEF0123_2026-11-12');
  assert.equal(companyPdfName(code,date),'CNPJ_Q-ABCDEF0123_2026-11-12');
});

test('D2: CPI usa pesquisaId e solicitacaoId',()=>{
  assert.equal(cpiPdfName(ids,date),'CPI_537987_275064_2026-11-12');
  assert.throws(()=>cpiPdfName({pesquisaId:'29',solicitacaoId:'x'},date),/inválid/);
  assert.throws(()=>cpiPdfName(ids,'12/11/2026'),/inválid/);
});

test('nome gerado nunca contém CPF nem CNPJ, mesmo com código ausente ou indevido',()=>{
  const names=[
    personPdfName(code,date),pisPdfName(code,date),companyPdfName(code,date),cpiPdfName(ids,date),
    personPdfName(undefined,date),pisPdfName(undefined,date),companyPdfName(undefined,date),
    // Um documento passado por engano no lugar do código não pode virar nome de arquivo.
    personPdfName(CPF,date),pisPdfName(CPF,date),companyPdfName(CNPJ,date)
  ];
  for(const name of names){assert.doesNotMatch(name,new RegExp(`${CPF}|${CNPJ}`),name);}
  assert.equal(personPdfName(CPF,date),`RELATORIO_${PDF_NO_CODE}_2026-11-12`);
});

test('padrão CPI aceita só o par do item, com ou sem sufixo -NN',()=>{
  const pattern=cpiPdfPattern(ids);
  assert.ok(pattern.test('CPI_537987_275064_2026-11-12.pdf'));
  assert.ok(pattern.test('CPI_537987_275064_2026-11-12-02.pdf'));
  assert.ok(!pattern.test('CPI_1537987_275064_2026-11-12.pdf'));
  assert.ok(!pattern.test('CPI_537987_2750641_2026-11-12.pdf'));
  assert.ok(!pattern.test('CPI_537988_275064_2026-11-12.pdf'));
  assert.ok(!pattern.test(`RELATORIO_${CPF}_2026-11-12.pdf`));
  assert.ok(!pattern.test('CPI_537987_275064_2026-11-12-100.pdf'));
});

test('limpeza reconhece nomes novos e legados, nunca arquivos de terceiros',()=>{
  for(const name of ['CPI_537987_275064_2026-11-12.pdf','RELATORIO_Q-ABCDEF0123_2026-11-12-03.pdf',
    `PIS_${PDF_NO_CODE}_2026-11-12.pdf`,'CNPJ_Q-ABCDEF0123_2026-11-12.pdf',
    `RELATORIO_${CPF}_2026-10-30.pdf`,`CNPJ_${CNPJ}_2026-10-30.pdf`,`DESKDATA_${CPF}_2026-10-30-100.pdf`])
    assert.ok(isManagedPdfName(name),name);
  for(const name of ['fatura.pdf','documento-terceiro.pdf','RELATORIO_2026-11-12.pdf','CPI_29_1_2026-11-12.pdf','RELATORIO_Q-ABCDEF0123_2026-11-12.exe'])
    assert.ok(!isManagedPdfName(name),name);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCpiPersonDetails, parseCpiDetailHeadingId, resolveCpiDetailHeadings } from '../src/main/cpi/pending-details.ts';

const ids={pesquisaId:'537987',solicitacaoId:'275064'};
const raw={
  solicitacaoHeading:'Dados Solicitação 275064',
  pesquisaHeading:'Dados da Pesquisa - 537987',
  pesquisaType:'PROCESSOS JUDICIAIS CRIMINAL FORUM NACIONAL CPF',
  cpfText:'529.982.247-25', // CPF de teste, não é dado do portal
  status:'Aguardando Pesquisa'
};

test('CPI detalhe: valida pesquisa, solicitação, tipo, CPF e status sem publicar CPF completo',()=>{
  const result=validateCpiPersonDetails(ids,raw);
  assert.equal(result.cpf,'52998224725');
  assert.equal(result.publicDetail.cpfValidated,true);
  assert.equal(result.publicDetail.status,'aguardando');
  assert.ok(!JSON.stringify(result.publicDetail).includes(result.cpf));
});

test('CPI detalhe: bloqueia IDs diferentes',()=>{
  assert.throws(()=>validateCpiPersonDetails(ids,{...raw,pesquisaHeading:'Dados da Pesquisa - 777777'}),/não corresponde/);
  assert.throws(()=>validateCpiPersonDetails(ids,{...raw,solicitacaoHeading:'Dados Solicitação 111111'}),/não corresponde/);
});

test('CPI detalhe: bloqueia tipo diferente ou pesquisa respondida',()=>{
  assert.throws(()=>validateCpiPersonDetails(ids,{...raw,pesquisaType:'PIS'}),/modalidade/);
  assert.throws(()=>validateCpiPersonDetails(ids,{...raw,status:'Respondida'}),/já não está aguardando/);
});

test('CPI detalhe: bloqueia CPF ausente, malformado ou com dígitos verificadores inválidos',()=>{
  for(const cpfText of ['', '111.111.111-11', '529.982.247-26']) {
    assert.throws(()=>validateCpiPersonDetails(ids,{...raw,cpfText}),/CPF ausente ou inválido/);
  }
});

test('CPI 6D: aceita títulos legados com ou sem DA e separadores sem relaxar IDs', () => {
  const result = validateCpiPersonDetails(ids, {
    ...raw,
    solicitacaoHeading: 'Dados da Solicitação: 275064',
    pesquisaHeading: 'Dados da Pesquisa: 537987'
  });
  assert.equal(result.cpf, '52998224725');
  assert.equal(parseCpiDetailHeadingId('Dados Solicitação - 275064', 'solicitacao'), ids.solicitacaoId);
  assert.equal(parseCpiDetailHeadingId('Dados da Solicitação 275064', 'solicitacao'), ids.solicitacaoId);
});

test('CPI 6D: rejeita IDs divergentes mesmo em cabeçalhos com variações', () => {
  assert.throws(() => validateCpiPersonDetails(ids, {
    ...raw, solicitacaoHeading: 'Dados da Solicitação: 275065'
  }), /não corresponde|outra pesquisa|outra solicitacao/i);
  assert.throws(() => validateCpiPersonDetails(ids, {
    ...raw, pesquisaHeading: 'Dados da Pesquisa 537988'
  }), /não corresponde|outra pesquisa|outra solicitacao/i);
});

test('CPI 6D: rejeita ID parcial e cabeçalho contendo múltiplos IDs', () => {
  assert.equal(parseCpiDetailHeadingId('Dados Solicitação 1275064', 'solicitacao'), '1275064');
  assert.equal(parseCpiDetailHeadingId('Dados Solicitação 275064 / 275065', 'solicitacao'), null);
  assert.throws(() => validateCpiPersonDetails(ids, {
    ...raw, solicitacaoHeading: 'Dados Solicitação 1275064'
  }), /não corresponde/);
});

test('CPI 6D: não prossegue quando o cadastro CPF + Dados P.F. não apresenta CPF validável', () => {
  assert.throws(() => validateCpiPersonDetails(ids, {
    ...raw, cpfText: ''
  }), /CPF ausente ou inválido/);
});

test('CPI 6D: diagnóstico de IDs mostra somente números de pesquisa e solicitação', () => {
  assert.throws(() => validateCpiPersonDetails(ids, {
    ...raw, solicitacaoHeading: 'Dados Solicitação 275065'
  }), error => {
    assert.match(error.message, /esperado pesquisa 537987\/solicitação 275064/);
    assert.match(error.message, /exibido pesquisa 537987\/solicitação 275065/);
    assert.ok(!error.message.includes(raw.cpfText));
    return true;
  });
});


test('CPI 6E: reconhece identificadores de titulos fora dos h2 (template CPF + Dados P.F.)', () => {
  const headings = resolveCpiDetailHeadings([
    'Dados Solicitação 275064', 'Dados da Pesquisa - 537987'
  ]);
  assert.deepEqual(headings, {
    solicitacaoHeading: 'Dados Solicitação 275064',
    pesquisaHeading: 'Dados da Pesquisa - 537987'
  });
  assert.equal(validateCpiPersonDetails(ids, {...raw, ...headings}).cpf, '52998224725');
});

test('CPI 6E: duplicidade de titulo com mesmo ID e permitida, mas IDs distintos bloqueiam', () => {
  assert.ok(resolveCpiDetailHeadings(['Dados Solicitação 275064',
    'Dados da Solicitação: 275064', 'Dados da Pesquisa - 537987']));
  assert.equal(resolveCpiDetailHeadings(['Dados Solicitação 275064',
    'Dados Solicitação 275065', 'Dados da Pesquisa - 537987']), null);
});

test('CPI 6E: nunca aceita ID parcial ou formulario sem ambos os titulos', () => {
  assert.equal(resolveCpiDetailHeadings(['Dados Solicitação 275064']), null);
  const headings = resolveCpiDetailHeadings([
    'Dados Solicitação 1275064', 'Dados da Pesquisa - 537987'
  ]);
  assert.throws(() => validateCpiPersonDetails(ids, {...raw, ...headings}), /não corresponde/);
});

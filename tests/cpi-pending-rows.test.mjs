import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectPendingPerson29Rows, isCpiNumericIdentifier, validateCpiRowId
} from '../src/main/cpi/pending-rows.ts';

const pendingUrl = 'https://adm.cpicentral.com.br/zpersEspecial/pesquisas/aguardando/mod_t_aguardando.aspx';
const columns = ['♙', 'API', 'ID Solicit.', 'Data', 'Cliente', 'Usuário', 'Tipo Pesquisa', 'Chave'];
const type29 = 'PROCESSOS JUDICIAIS CRIMINAL FORUM NACIONAL CPF';

function grid(rows, headers = columns) {
  const node = (text, sensitive = false) => ({
    matches: selector => selector.includes('.cell'),
    get innerText() { if (sensitive) throw Error('Tentativa de ler dado pessoal na coluna proibida'); return text; },
    get textContent() { if (sensitive) throw Error('Tentativa de ler dado pessoal na coluna proibida'); return text; }
  });
  const row = (cells, isHeader = false) => ({ children: cells.map((text, i) => node(text, !isHeader && [4,5,7].includes(i))) });
  const records = [row(headers, true), ...rows.map(values => row(values))];
  return {querySelectorAll: () => records};
}
function pageFor(t, roots, actions = []) {
  return {
    url: () => pendingUrl,
    frames: () => [{
      url: () => pendingUrl,
      evaluate: fn => {
        const prior = globalThis.document;
        globalThis.document = { querySelectorAll: selector => selector.includes('Responder / Atualizar') ? actions : roots };
        try {return Promise.resolve(fn());} finally { globalThis.document = prior; }
      }
    }]
  };
}
function personRow(pesquisa, solicitacao, type = type29) {
  return [pesquisa, '', solicitacao, '04/11/2026', 'NOME SIGILOSO', 'USUARIO SIGILOSO', type, '123.456.789-00'];
}

test('CPI 3B: IDs devem ser numericos, sem valores ambíguos ou texto', () => {
  assert.equal(isCpiNumericIdentifier('531834'), true);
  for (const v of ['0','531','531834a','123.456.789-00','', '9999999999999']) {
    assert.equal(isCpiNumericIdentifier(v), false);
  }
  assert.deepEqual(validateCpiRowId({pesquisaId:'531834',solicitacaoId:'271528'}),
    {pesquisaId:'531834',solicitacaoId:'271528'});
  assert.equal(validateCpiRowId({pesquisaId:'ABC',solicitacaoId:'271528'}), null);
});

test('CPI 3B: rodape zero é vazio confirmado sem inspecionar dados', async t => {
  const result = await inspectPendingPerson29Rows(pageFor(t, []), 0);
  assert.equal(result.state,'empty');
  assert.deepEqual(result.rows,[]);
});

test('CPI 3B: rodape sem confirmacao impede leitura de linhas', async t => {
  const result = await inspectPendingPerson29Rows(pageFor(t, []), null);
  assert.equal(result.state,'unconfirmed');
  assert.equal(result.rows.length,0);
});

test('CPI 3B: IDs corretos na tabela com cabeçalhos confirmados sem expor CPF ou nome', async t => {
  const view = grid([personRow('531834','271528'),personRow('531817','271516')]);
  const result = await inspectPendingPerson29Rows(pageFor(t,[view]),2);
  assert.equal(result.state,'mapped');
  assert.deepEqual(result.rows,[
    {pesquisaId:'531834',solicitacaoId:'271528'},
    {pesquisaId:'531817',solicitacaoId:'271516'}
  ]);
  assert.equal(JSON.stringify(result).includes('123.456'),false);
  assert.equal(JSON.stringify(result).includes('NOME SIGILOSO'),false);
});

test('CPI 3B: mais registros no rodape do que na pagina limita escopo à pagina atual', async t => {
  const result = await inspectPendingPerson29Rows(pageFor(t,[grid([personRow('531834','271528')])]),7);
  assert.equal(result.state,'mapped');
  assert.equal(result.total,7);
  assert.equal(result.rows.length,1);
  assert.match(result.message,/outras páginas/);
});

test('CPI 3B: IDs inválidos bloqueiam mapeamento integral e não retornam dados parciais', async t => {
  const result = await inspectPendingPerson29Rows(pageFor(t,[grid([personRow('531834','271528'),personRow('ABC','271516')])]),2);
  assert.equal(result.state,'needs_mapping');
  assert.deepEqual(result.rows,[]);
});

test('CPI 3B: tipo desconhecido bloqueia associação automática', async t => {
  const result = await inspectPendingPerson29Rows(pageFor(t,[grid([personRow('531834','271528','PIS')])]),1);
  assert.equal(result.state,'needs_mapping');
  assert.deepEqual(result.rows,[]);
});

test('CPI 3B: colunas sem cabeçalho confirmado bloqueiam mapeamento', async t => {
  const result = await inspectPendingPerson29Rows(pageFor(t,[grid([personRow('531834','271528')],['Coluna','Campo'])]),1);
  assert.equal(result.state,'needs_mapping');
});

test('CPI 3B: domínio externo ou tela incorreta bloqueia leitura', async () => {
  await assert.rejects(() => inspectPendingPerson29Rows({ url: () => 'https://example.org', frames: () => []}, 1),/página de pesquisas/);
});

test('CPI 3B hotfix: lê div.table real com checkbox antes do ID da pesquisa', async () => {
  const headers = ['','♙','API','ID Solicit.','Data','Cliente','Usuário','Tipo Pesquisa','Chave'];
  const valueRows = [
    ['', '537987', '', '275064', '10/11 13:57', 'SIGILOSO', 'SIGILOSO', type29, 'XXX.XXX.XXX-XX']
  ];
  const node = (text) => ({matches: selector => selector.includes('.cell'), innerText:text, textContent:text});
  const gridRows = [headers,...valueRows].map(row => ({children:row.map(node)}));
  const result = await inspectPendingPerson29Rows(pageFor(null,[{querySelectorAll: () => gridRows}]),1);
  assert.equal(result.state, 'mapped');
  assert.deepEqual(result.rows,[{pesquisaId:'537987',solicitacaoId:'275064'}]);
});

test('CPI 3B hotfix: não usa o primeiro número aleatório como ID quando há ambiguidade', async () => {
  const headers = ['','♙','API','ID Solicit.','Data','Cliente','Usuário','Tipo Pesquisa','Chave'];
  const row = ['', '537987', '531834', '275064', '', '', '', type29, 'XXX'];
  const node = (text) => ({matches: selector => selector.includes('.cell'), innerText:text, textContent:text});
  const gridRows = [headers,row].map(cells => ({children:cells.map(node)}));
  const result = await inspectPendingPerson29Rows(pageFor(null,[{querySelectorAll:()=>gridRows}]),1);
  assert.equal(result.state,'needs_mapping');
  assert.deepEqual(result.rows,[]);
});

// DOM observado na CPI: botao i[title="Responder / Atualizar"] dentro da
// propria div.row; a acao publica IDs na query string do onclick.
function actionRow(pesquisa, solicitacao, options = {}) {
  const type = options.type ?? type29;
  const text = ['', pesquisa, '', solicitacao, '10/11 13:57', 'CLIENTE SIGILOSO', 'USUARIO SIGILOSO', type, 'XXX.XXX.XXX-XX'];
  const cells = text.map(value => ({
    matches: selector => selector.includes('.cell'),
    innerText: value,
    textContent: value
  }));
  const row = {
    children: cells,
    closest: selector => selector === '.table' ? { className: 'table' } : null
  };
  const onclick = options.onclick ?? `javascript:openShadowbox('/zpersEspecial/pesquisas/upd_cad/mod_tt_pesq_upd.aspx?id_cadastro=1&id_sol=${solicitacao}&id_pesq_tipo=${pesquisa}', 'iframe', 'Responder / Atualizar Pesquisa');`;
  const action = {
    closest: selector => selector === '.row' ? row : null,
    getAttribute: attribute => attribute === 'onclick' ? onclick : null
  };
  return action;
}

test('CPI 3B acao real: mapeia linha sem cabecalhos usando IDs conferidos do onclick', async () => {
  const result = await inspectPendingPerson29Rows(pageFor(null, [], [actionRow('642318','384527')]),1);
  assert.equal(result.state,'mapped');
  assert.deepEqual(result.rows,[{pesquisaId:'642318',solicitacaoId:'384527'}]);
  assert.equal(JSON.stringify(result).includes('CLIENTE SIGILOSO'),false);
  assert.equal(JSON.stringify(result).includes('XXX.XXX'),false);
});

test('CPI 3B acao real: bloqueia onclick com ID divergente da linha', async () => {
  const action = actionRow('642318','384527',{
    onclick:"javascript:openShadowbox('/zpersEspecial/pesquisas/upd_cad/mod_tt_pesq_upd.aspx?id_cadastro=1&id_sol=384528&id_pesq_tipo=642318', 'iframe', 'Responder / Atualizar Pesquisa');"
  });
  const result = await inspectPendingPerson29Rows(pageFor(null, [], [action]),1);
  assert.equal(result.state,'needs_mapping');
  assert.deepEqual(result.rows,[]);
  assert.match(result.message,/1 controles Responder/);
});

test('CPI 3B acao real: rejeita pesquisa que nao corresponde a modalidade 29', async () => {
  const result = await inspectPendingPerson29Rows(pageFor(null, [], [actionRow('642318','384527',{type:'PIS'})]),1);
  assert.equal(result.state,'needs_mapping');
  assert.deepEqual(result.rows,[]);
});

test('CPI 3B acao real: rejeita link de outro formulario', async () => {
  const result = await inspectPendingPerson29Rows(pageFor(null, [], [actionRow('642318','384527',{
    onclick:"javascript:openShadowbox('/outro/mod_tt_pesq_upd.aspx?id_sol=384527&id_pesq_tipo=642318', 'iframe', 'Responder / Atualizar Pesquisa');"
  })]),1);
  assert.equal(result.state,'needs_mapping');
});

test('CPI 3B acao real: duplicidade de acoes impede mapeamento automatico', async () => {
  const action = actionRow('642318','384527');
  const result = await inspectPendingPerson29Rows(pageFor(null, [], [action,action]),1);
  assert.equal(result.state,'needs_mapping');
  assert.deepEqual(result.rows,[]);
});

test('E2: sem teto local de 100 linhas; 150 linhas válidas são mapeadas em ordem', async () => {
  const actions = Array.from({length:150}, (_, i) => actionRow(String(700000 + i), String(400000 + i)));
  const result = await inspectPendingPerson29Rows(pageFor(null, [], actions), 150);
  assert.equal(result.state,'mapped');
  assert.equal(result.rows.length,150);
  assert.deepEqual(result.rows[149],{pesquisaId:'700149',solicitacaoId:'400149'});
});

test('CPI 3B acao real: multiplas linhas validas preservam ordem e IDs distintos', async () => {
  const result = await inspectPendingPerson29Rows(pageFor(null, [], [
    actionRow('642318','384527'), actionRow('642319','384528')
  ]),2);
  assert.equal(result.state,'mapped');
  assert.deepEqual(result.rows,[
    {pesquisaId:'642318',solicitacaoId:'384527'},
    {pesquisaId:'642319',solicitacaoId:'384528'}
  ]);
});

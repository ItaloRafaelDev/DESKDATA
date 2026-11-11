import test from 'node:test';
import assert from 'node:assert/strict';
import { isPostSaveListingReady, refreshPendingAfterConfirmedSave } from '../src/main/cpi/pending-refresh.ts';
import { CPI_PENDING_URL } from '../src/main/cpi/pending-filter.ts';

const done = { pesquisaId: '538825', solicitacaoId: '275530' };
const next = { pesquisaId: '538824', solicitacaoId: '275529' };
const mapped = rows => ({ state: 'mapped', total: rows.length, rows, visibleRows: rows.length, framesInspected: 1, message: '' });

test('listagem pós-salvamento exige ausência do ID respondido e mapeamento válido', () => {
  assert.equal(isPostSaveListingReady(2, mapped([done, next]), done), false);
  assert.equal(isPostSaveListingReady(1, mapped([next]), done), true);
  assert.equal(isPostSaveListingReady(0, { state: 'empty', total: 0, rows: [], visibleRows: 0, framesInspected: 0, message: '' }, done), true);
  assert.equal(isPostSaveListingReady(2, { ...mapped([next]), total: 2 }, done), true);
  assert.equal(isPostSaveListingReady(null, mapped([next]), done), false);
  assert.equal(isPostSaveListingReady(1, { ...mapped([next]), state: 'needs_mapping' }, done), false);
});

function fakePage({stale = false} = {}) {
  const state = { clicked: 0, waitedModal: 0, read: 0 };
  const frame = {
    url: () => CPI_PENDING_URL,
    locator: () => ({ count: async () => 1, isVisible: async () => true, click: async () => { state.clicked++; } }),
    evaluate: async fn => {
      if (String(fn).includes('document.body?.innerText.match')) {
        return stale ? 'Mostrando: 1 à 2 ( de 2 registros )' : 'Mostrando: 1 à 1 ( de 1 registro )';
      }
      state.read++;
      const rows = stale ? [done, next] : [next];
      return { candidateGrids: 1, visibleRows: rows.length, rows, uncertainRows: 0, actionButtons: rows.length };
    }
  };
  const page = {
    url: () => CPI_PENDING_URL,
    locator: () => ({ waitFor: async ({state: expected}) => { assert.equal(expected, 'hidden'); state.waitedModal++; } }),
    frames: () => [frame],
    waitForTimeout: async () => { await new Promise(resolve => setTimeout(resolve, 1)); }
  };
  return { page, state };
}

test('fecha modal, clica Mostrar Tudo e exige duas leituras iguais sem a pesquisa respondida', async () => {
  const {page,state} = fakePage();
  await refreshPendingAfterConfirmedSave(page, done, 1500);
  assert.equal(state.waitedModal, 1);
  assert.equal(state.clicked, 1);
  assert.ok(state.read >= 2);
});

test('nao prossegue se a CPI mantiver a linha respondida em cache', async () => {
  const {page,state} = fakePage({stale:true});
  await assert.rejects(() => refreshPendingAfterConfirmedSave(page, done, 35), /não confirmou a atualização/);
  assert.equal(state.clicked, 1);
});

test('nunca clica se estiver fora da pagina de listagem', async () => {
  const {page,state} = fakePage();
  page.url = () => 'https://adm.cpicentral.com.br/acesso/checkUser.aspx';
  await assert.rejects(() => refreshPendingAfterConfirmedSave(page, done), /não confirmada/);
  assert.equal(state.clicked, 0);
});

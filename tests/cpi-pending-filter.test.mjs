import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCpiListingCount, CPI_PENDING_URL, CPI_PERSON_TYPE_ID, setCpiFilterCheckbox } from '../src/main/cpi/pending-filter.ts';

test('CPI: estado vazio real no rodapé da listagem', () => {
  assert.equal(parseCpiListingCount('Mostrando: 0 à 0 ( de 0 registro )'), 0);
});
test('CPI: total positivo', () => {
  assert.equal(parseCpiListingCount('Mostrando: 1 à 10 ( de 35 registros )'), 35);
});
test('CPI: desconhecido não significa vazio', () => {
  assert.equal(parseCpiListingCount('Carregando...'), null);
  assert.equal(parseCpiListingCount('Erro no servidor'), null);
});
test('CPI: valores não numéricos e gigantes não são totais válidos', () => {
  assert.equal(parseCpiListingCount('Mostrando: 1 à 10 ( de X registros )'), null);
  assert.equal(parseCpiListingCount('Mostrando: 1 à 10 ( de 999999999999999 registros )'), null);
});
test('CPI: contrato da tela e tipo 29 mapeados pelas capturas', () => {
  assert.equal(new URL(CPI_PENDING_URL).hostname, 'adm.cpicentral.com.br');
  assert.equal(CPI_PERSON_TYPE_ID, '29');
});

function fakeCheckboxLocator(initialChecked = false, { disabled = false, tag = 'INPUT', type = 'checkbox' } = {}) {
  const element = { tagName: tag, type, disabled, checked: initialChecked, clicks: 0,
    click() { this.clicks++; if (!this.disabled) this.checked = !this.checked; } };
  return {
    element,
    // O teste não oferece locator.check/uncheck: só o clique DOM funciona fora do viewport.
    locator: {
      isChecked: async () => element.checked,
      evaluate: async (callback, desired) => callback(element, desired)
    }
  };
}

test('CPI: seleciona checkbox 29 sem depender de clique por coordenadas', async () => {
  const { locator, element } = fakeCheckboxLocator();
  await setCpiFilterCheckbox(locator, true);
  assert.equal(element.checked, true);
  assert.equal(element.clicks, 1);
});

test('CPI: desmarca opções previamente selecionadas com evento nativo', async () => {
  const { locator, element } = fakeCheckboxLocator(true);
  await setCpiFilterCheckbox(locator, false);
  assert.equal(element.checked, false);
  assert.equal(element.clicks, 1);
});

test('CPI: evita clique redundante quando o checkbox já está correto', async () => {
  const { locator, element } = fakeCheckboxLocator(true);
  await setCpiFilterCheckbox(locator, true);
  assert.equal(element.clicks, 0);
});

test('CPI: falha com checkbox desabilitado em vez de fingir sucesso', async () => {
  const { locator } = fakeCheckboxLocator(false, { disabled: true });
  await assert.rejects(() => setCpiFilterCheckbox(locator, true), /desabilitado/);
});

test('CPI: rejeita elementos inesperados mesmo que tenham checked', async () => {
  const { locator } = fakeCheckboxLocator(false, { tag: 'DIV' });
  await assert.rejects(() => setCpiFilterCheckbox(locator, true), /inválido/);
});

test('CPI: estado não alterado após clique gera erro verificável', async () => {
  const { locator, element } = fakeCheckboxLocator(false);
  element.click = () => { element.clicks++; };
  await assert.rejects(() => setCpiFilterCheckbox(locator, true), /não confirmou/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { parseCpiListingCount, CPI_PENDING_URL, CPI_PERSON_TYPE_ID, setCpiFilterCheckbox } from '../src/main/cpi/pending-filter.ts';
import { CpiBrowser } from '../src/main/cpi/cpi-browser.ts';
import { classifyCpiError } from '../src/main/cpi/failure-classes.ts';

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

async function withFilterPortal(modalOpen, run) {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
    <style>#sb-container{position:fixed;inset:0;z-index:100;background:white;display:${modalOpen ? 'block' : 'none'}}</style>
    <button title="Filtros Avançados" onclick="window.advancedClicks++;document.getElementById('tipos').hidden=false">Filtros</button>
    <div id="tipos" hidden>
      <input id="id_tipo_pesq_29" type="checkbox" value="29,Pessoa">
      <input id="id_tipo_pesq_30" type="checkbox" value="30,Empresa" checked>
      <a href="#" onclick="event.preventDefault();document.getElementById('tipos').hidden=true">Selecionar</a>
    </div>
    <button title="Mostrar Tudo" onclick="window.showAllClicks++;document.getElementById('total').textContent='Mostrando: 1 à 2 ( de 2 registros )'">Tudo</button>
    <div id="total">Mostrando: 0 à 0 ( de 0 registro )</div>
    <div id="sb-container"><div id="sb-title-inner">Responder / Atualizar Pesquisa <a title="Fechar" onclick="Shadowbox.close()">x</a></div></div>
    <script>window.advancedClicks=0;window.showAllClicks=0;window.manualCloses=0;
      var Shadowbox={close:function(){window.manualCloses++;document.getElementById('sb-container').style.display='none';}};</script>
  ` }));
  const page = await context.newPage();
  // modalState de produção (fail-closed: estouro conta como modal aberto); filtro finito e maior que ele.
  const driver = new CpiBrowser({ filter: 10_000 });
  driver.browser = browser; driver.page = page;
  try { await page.goto(CPI_PENDING_URL); await run({driver,page}); }
  finally { await context.close(); await browser.close(); }
}

test('CPI: Shadowbox aberta bloqueia o filtro sem clique; fechamento manual libera o retorno à listagem',()=>withFilterPortal(true,async({driver,page})=>{
  const error=await driver.filterPendingPerson29().catch(value=>value);
  assert.equal(classifyCpiError(error),'cpi_operational');
  assert.match(error.message,/Pendência operacional CPI/);
  assert.equal(await page.evaluate(()=>window.advancedClicks),0,'o filtro não tenta clicar atrás do modal');
  await page.evaluate(()=>globalThis.Shadowbox.close());
  assert.deepEqual(await driver.filterPendingPerson29(),{typeId:'29',total:2,state:'found'});
  assert.deepEqual(await page.evaluate(()=>({manualCloses:globalThis.manualCloses,advancedClicks:globalThis.advancedClicks,
    showAllClicks:globalThis.showAllClicks})),
    {manualCloses:1,advancedClicks:1,showAllClicks:1});
  assert.equal(driver.operationalHold,null);
}));

test('CPI: listagem sem Shadowbox aplica o filtro 29 normalmente',()=>withFilterPortal(false,async({driver,page})=>{
  const steps=[];const timer={step:async(name,work)=>{steps.push(name);return work();}};
  assert.deepEqual(await driver.filterPendingPerson29(timer),{typeId:'29',total:2,state:'found'});
  assert.deepEqual(await page.evaluate(()=>({advancedClicks:globalThis.advancedClicks,showAllClicks:globalThis.showAllClicks})),
    {advancedClicks:1,showAllClicks:1});
  assert.deepEqual(steps,['cpi_filter_modal','cpi_filter_open','cpi_filter_type','cpi_filter_select',
    'cpi_filter_apply','cpi_filter_refresh','cpi_filter_listing']);
}));

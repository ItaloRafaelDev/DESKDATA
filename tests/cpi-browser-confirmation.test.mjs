import test from 'node:test';
import assert from 'node:assert/strict';
import { portalFixture, persisted, ids } from './helpers/cpi-portal.mjs';
import { realPortalFixture, ids as realIds } from './helpers/cpi-portal-real.mjs';

// E6 (2ª rodada): o envio segue o DOM real do portal (link "Alterar" → upd_pesq(), confirm nativo, Shadowbox).
// Confirmação = confirm aceito + modal fechado; a listagem é conferida depois em closeCompletedDetail
// (tests/v02-validacao-anexo.test.mjs). Os testes de "evidência persistida" no upload foram removidos: o portal
// real não devolve página com campos persistidos após salvar. A reconciliação (fim do arquivo) continua neles.

function stepRecorder(){
  const steps=[];
  return {steps,timer:{begin:step=>{let done=false;return state=>{if(!done){done=true;steps.push(`${step}:${state}`);}};}}};
}

test('CPI: tempos de abrir detalhe, ler CPF, preencher, anexar e salvar são medidos em etapas separadas',()=>realPortalFixture({},async({driver,pdf})=>{
  const {steps,timer}=stepRecorder();
  await driver.inspectPendingPersonDetails(realIds,timer);
  assert.equal(await driver.uploadAndSavePersonResponse(realIds,pdf,'information',4000,timer),'confirmed');
  assert.deepEqual(steps,['cpi_open_detail:success','cpi_read_cpf:success','cpi_fill:success','cpi_attach:success','cpi_save:success']);
}));

test('CPI: salvamento sem confirmação encerra a etapa de salvar como falha',()=>realPortalFixture({postStatus:500},async({driver,pdf,saves,modalVisible})=>{
  const {steps,timer}=stepRecorder();
  assert.equal(await driver.uploadAndSavePersonResponse(realIds,pdf,'information',800,timer),'unverified');
  assert.deepEqual(steps,['cpi_fill:success','cpi_attach:success','cpi_save:failed']);
  assert.equal(saves().length,1);assert.equal(await modalVisible(),true);
}));

test('CPI: erro de conexão após clicar em Alterar não autoriza repetir',()=>realPortalFixture({abortSave:true},async({driver,pdf,saves})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(realIds,pdf,'information',800),'unverified');
  assert.equal(saves().length,1);
}));

test('CPI: troca do frame após leitura impede anexar e submeter',()=>realPortalFixture({},async({driver,page,pdf,saves})=>{
  await page.evaluate(()=>{
    const old=document.querySelector('#sb-content'),next=document.createElement('iframe');
    next.id='sb-content';next.src=old.src;old.replaceWith(next);
  });
  await page.locator('#sb-content').contentFrame().locator('select[name=id_pesq_status]').waitFor({state:'attached'});
  assert.equal(await driver.uploadAndSavePersonResponse(realIds,pdf,'information',800),'not_submitted');
  assert.equal(saves().length,0);
}));

test('CPI: IDs alterados antes do upload impedem envio comprovadamente',()=>realPortalFixture({},async({driver,frame,pdf,saves})=>{
  await frame().locator('h2').first().evaluate(node=>{node.textContent='Dados Solicitação 1277705';});
  assert.equal(await driver.uploadAndSavePersonResponse(realIds,pdf,'information',800),'not_submitted');
  assert.equal(saves().length,0);
}));

test('CPI: identidade alterada durante preenchimento impede o envio a outra pesquisa',()=>realPortalFixture({
  beforeClickScript:"document.querySelector('h2').textContent='Dados Solicitação 1277705';"
},async({driver,pdf,saves})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(realIds,pdf,'information',800),'not_submitted');
  assert.equal(saves().length,0);
}));

test('CPI: template homologado fora de h2 usa os mesmos IDs no envio',()=>realPortalFixture({legacy:true},async({driver,pdf,saves})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(realIds,pdf,'information',4000),'confirmed');
  assert.equal(saves().length,1);
}));

test('CPI: reconciliação lê resposta persistida sem POST e correlaciona o formulário aberto',()=>portalFixture({},async({driver,page,posts})=>{
 const frame=await (await page.locator('#sb-content').elementHandle()).contentFrame();
 await page.route('**/mod_tt_pesq_upd.aspx*',route=>route.fulfill({contentType:'text/html',body:persisted()}));
 await frame.evaluate(html=>{document.open();document.write(html);document.close();},persisted());
 assert.equal(await driver.inspectPersistedPersonResponse(ids,'information','52998224725'),'confirmed');
 assert.equal(posts(),0);
 assert.equal(await driver.inspectPersistedPersonResponse({...ids,pesquisaId:'1537987'},'information','52998224725'),'unavailable');
}));

test('CPI: reconciliação não confirma classificação divergente nem campos ausentes',()=>portalFixture({},async({driver,page,posts})=>{
 const frame=await (await page.locator('#sb-content').elementHandle()).contentFrame();
 await page.route('**/mod_tt_pesq_upd.aspx*',route=>route.fulfill({contentType:'text/html',body:persisted({omit:'pdf'})}));
 await frame.evaluate(html=>{document.open();document.write(html);document.close();},persisted({omit:'pdf'}));
 assert.equal(await driver.inspectPersistedPersonResponse(ids,'information','52998224725'),'unverified');
 await frame.evaluate(html=>{document.open();document.write(html);document.close();},persisted());
 await page.route('**/mod_tt_pesq_upd.aspx*',route=>route.fulfill({contentType:'text/html',body:persisted()}));
 assert.equal(await driver.inspectPersistedPersonResponse(ids,'restrictions','52998224725'),'unverified');
 assert.equal(posts(),0);
}));

test('CPI: formulário em memória sem persistência após GET não conclui reconciliação',()=>portalFixture({},async({driver,page,posts})=>{
 const frame=await (await page.locator('#sb-content').elementHandle()).contentFrame();
 await frame.evaluate(html=>{document.open();document.write(html);document.close();},persisted());
 assert.equal(await driver.inspectPersistedPersonResponse(ids,'information','52998224725'),'unverified');
 assert.equal(posts(),0);
}));

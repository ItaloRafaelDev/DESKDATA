import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { portalFixture, ids, persisted, editable, postedField } from './helpers/cpi-portal.mjs';

function stepRecorder(){
  const steps=[];
  return {steps,timer:{begin:step=>{let done=false;return state=>{if(!done){done=true;steps.push(`${step}:${state}`);}};}}};
}
const modalVisible=page=>page.locator('#sb-container').isVisible();

// ---------- preenchimento e envio (sequência do portal real) ----------
test('CPI: Há Informações preenche Fonte, Status, #consta2 e anexa o PDF; Fonte 1º intocada',()=>portalFixture({},async({driver,pdf,posts,body,attachedFile})=>{
  const before=await readFile(pdf);
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000),'confirmed');
  assert.equal(posts(),1);
  assert.equal(postedField(body(),'id_pesquisador'),'DESKDATA');
  assert.equal(postedField(body(),'id_pesquisador_prim'),'INDEF');
  assert.equal(postedField(body(),'id_pesq_status'),'RESPONDIDA');
  assert.equal(postedField(body(),'consta'),'C2');
  assert.equal(postedField(body(),'permanecer'),null);
  assert.ok(body().includes(Buffer.from('CPI_537987_275064_2026-11-13.pdf')));
  assert.deepEqual(attachedFile(),before);
  assert.deepEqual(await readFile(pdf),before);
}));

test('CPI: Sim, Consta Restrições marca #consta3 e nunca Nada Consta',()=>portalFixture({},async({driver,pdf,posts,body})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'restrictions',3000),'confirmed');
  assert.equal(posts(),1);
  assert.equal(postedField(body(),'consta'),'C3');
}));

test('CPI: Status que recarrega o bloco e zera a Fonte é reaplicado até a Fonte ficar Desk Data',()=>portalFixture({statusReloads:true},async({driver,pdf,body})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000),'confirmed');
  assert.equal(postedField(body(),'id_pesquisador'),'DESKDATA');
  assert.equal(postedField(body(),'id_pesq_status'),'RESPONDIDA');
}));

test('CPI: "Permanecer nesta tela" marcado é desmarcado antes de salvar',()=>portalFixture({keepChecked:true},async({driver,pdf,body})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000),'confirmed');
  assert.equal(postedField(body(),'permanecer'),null);
}));

test('CPI: retorno automático à lista (modal fechado pelo portal) é confirmado',()=>portalFixture({afterSave:'list'},async({driver,page,pdf,posts})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000),'confirmed');
  assert.equal(posts(),1);assert.equal(await modalVisible(page),false);
}));

for(const afterSave of ['error_alert','error_text','login','http500']){
  test(`CPI: resposta do portal com ${afterSave} fica incerta, sem segundo envio`,()=>portalFixture({afterSave},async({driver,pdf,posts})=>{
    assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000),'unverified');
    assert.equal(posts(),1);
    await assert.rejects(driver.closeCompletedDetail(ids),/resposta não confirmada/);
  }));
}

// ---------- falhas antes do envio ----------
test('CPI: diálogo diferente do esperado é cancelado e nada é enviado',()=>portalFixture({confirmText:'Deseja excluir esta pesquisa?'},async({driver,pdf,posts})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',2000),'not_submitted');
  assert.equal(posts(),0);
}));

test('CPI: radios de Resultado que não aparecem impedem anexar e enviar',()=>portalFixture({noRadios:true},async({driver,pdf,posts,attachedFile})=>{
  driver.timeouts={...driver.timeouts,fieldWait:300};
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',2000),'not_submitted');
  assert.equal(posts(),0);assert.equal(attachedFile(),null);
}));

test('CPI: troca do frame após leitura impede anexar e submeter',()=>portalFixture({},async({driver,page,pdf,posts})=>{
  await page.evaluate(()=>{
    const old=document.querySelector('#sb-content'),next=document.createElement('iframe');
    next.id='sb-content';next.src=old.src;old.replaceWith(next);
  });
  await page.locator('#sb-content').contentFrame().locator('input[type="file"]').waitFor();
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',500),'not_submitted');
  assert.equal(posts(),0);
}));

test('CPI: IDs alterados antes do upload impedem envio comprovadamente',()=>portalFixture({},async({driver,page,pdf,posts})=>{
  await page.locator('#sb-content').contentFrame().locator('h2').first().evaluate(node=>{node.textContent='Dados Solicitação 1275064';});
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',500),'not_submitted');
  assert.equal(posts(),0);
}));

test('CPI: identidade alterada durante preenchimento impede anexar PDF a outra pesquisa',()=>portalFixture({
  initial:editable().replace('<select name="id_pesquisador">','<select name="id_pesquisador" onchange="document.querySelector(\'h2\').textContent=\'Dados Solicitação 1275064\'">')
},async({driver,pdf,posts,attachedFile})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',500),'not_submitted');
  assert.equal(posts(),0);assert.equal(attachedFile(),null);
}));

test('CPI: POST disparado pelo anexo torna o resultado incerto (sem clicar em Alterar)',()=>portalFixture({
  initial:editable().replace('id="MainPage_FileUpload1">','id="MainPage_FileUpload1" onchange="document.forms.form_cad.submit()">')
},async({driver,pdf,posts})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',2000),'unverified');
  assert.equal(posts(),1);
}));

// ---------- etapas medidas ----------
test('CPI: tempos de abrir detalhe, ler CPF, preencher, anexar e salvar são medidos em etapas separadas',()=>portalFixture({},async({driver,pdf})=>{
  const {steps,timer}=stepRecorder();
  await driver.inspectPendingPersonDetails(ids,timer);
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000,timer),'confirmed');
  assert.deepEqual(steps,['cpi_open_detail:success','cpi_read_cpf:success','cpi_fill:success','cpi_attach:success','cpi_save:success']);
}));

test('CPI: salvamento sem confirmação encerra a etapa de salvar como falha',()=>portalFixture({afterSave:'login'},async({driver,pdf})=>{
  const {steps,timer}=stepRecorder();
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000,timer),'unverified');
  assert.deepEqual(steps,['cpi_fill:success','cpi_attach:success','cpi_save:failed']);
}));

test('CPI: template com títulos fora de h2 usa os mesmos IDs no upload',()=>portalFixture({legacy:true},async({driver,pdf,posts})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000),'confirmed');
  assert.equal(posts(),1);
}));

// ---------- modo ensaio ----------
test('CPI: modo ensaio preenche e anexa, cancela o diálogo e não envia nada',()=>portalFixture({},async({driver,page,pdf,posts,attachedFile})=>{
  const {steps,timer}=stepRecorder();
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',2000,timer,'dry_run'),'dry_run_ok');
  assert.equal(posts(),0);assert.ok(attachedFile());
  assert.deepEqual(steps,['cpi_fill:success','cpi_attach:success','cpi_save:success']);
  const frame=page.locator('#sb-content').contentFrame();
  assert.equal(await frame.locator('select[name="id_pesquisador"] option:checked').innerText(),'Desk Data');
  assert.equal(await frame.locator('#consta2').isChecked(),true);
  await assert.rejects(driver.closeCompletedDetail(ids),/resposta não confirmada/);
  await driver.closeDetailWithoutSaving(ids);
  assert.equal(await modalVisible(page),false);assert.equal(posts(),0);
}));

// ---------- fechamento e prova pela listagem ----------
test('CPI: modal que não volta sozinho é fechado e a listagem confirma a resposta',()=>portalFixture({},async({driver,page,pdf})=>{
  const refreshed=[];driver.refreshAfterSave=async(_page,done)=>{refreshed.push(done);};
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000),'confirmed');
  assert.equal(await modalVisible(page),true);
  await driver.closeCompletedDetail(ids);
  assert.equal(await modalVisible(page),false);
  assert.deepEqual(refreshed,[ids]);
  await assert.rejects(driver.closeCompletedDetail(ids),/resposta não confirmada/);
}));

test('CPI: com o portal já na lista, só a listagem é conferida',()=>portalFixture({afterSave:'list'},async({driver,pdf})=>{
  const refreshed=[];driver.refreshAfterSave=async(_page,done)=>{refreshed.push(done);};
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000),'confirmed');
  await driver.closeCompletedDetail(ids);
  assert.deepEqual(refreshed,[ids]);
}));

test('CPI: listagem que ainda mostra a pesquisa impede liberar a próxima',()=>portalFixture({},async({driver,pdf})=>{
  driver.refreshAfterSave=async()=>{throw new Error('A CPI não confirmou a atualização da listagem após responder.');};
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000),'confirmed');
  await assert.rejects(driver.closeCompletedDetail(ids),/não confirmou a atualização/);
}));

// ---------- reconciliação (inalterada) ----------
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

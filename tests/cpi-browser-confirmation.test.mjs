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
  test(`CPI: resposta do portal com ${afterSave} fica incerta, sem segundo envio, e retém o navegador`,()=>portalFixture({afterSave},async({driver,pdf,posts})=>{
    assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000),'unverified');
    assert.equal(posts(),1);
    await assert.rejects(driver.finalizeSubmittedResponse(ids),/resposta não confirmada/);
    // A janela segue aberta para conferência: nenhuma outra pesquisa pode ser aberta.
    await assert.rejects(driver.inspectPendingPersonDetails(ids),/Pendência operacional CPI/);
  }));
}

// ---------- HTTP: documento principal × recurso auxiliar ----------
test('CPI: 404 no documento principal (POST de Alterar) nunca vira aviso auxiliar',()=>portalFixture({
  afterPost:route=>route.fulfill({status:404,contentType:'text/html',body:'<html><head><meta charset="utf-8"></head><body>404;404; Erro de Servidor no Aplicativo "/". URL solicitada: /cpi_api_request.aspx</body></html>'})
},async({driver,pdf,posts})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000),'unverified');
  assert.equal(posts(),1);
}));

test('CPI: recurso auxiliar com falha diferente de 404 não é mascarado (envio incerto)',()=>portalFixture({afterSave:'list_aux404',auxiliaryStatus:500},async({driver,pdf,posts})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000),'unverified');
  assert.equal(posts(),1);
}));

test('CPI: leitura independente com recurso auxiliar em HTTP 500 fica indisponível',()=>portalFixture({afterSave:'list',auxiliaryStatus:500,detailAfterPost:persisted({aux404:true})},async({driver,pdf})=>{
  refreshSpy(driver);
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000),'confirmed');
  assert.equal((await driver.finalizeSubmittedResponse(ids)).persistence,'unavailable');
}));

// ---------- falhas antes do envio ----------
test('CPI: diálogo diferente do esperado é cancelado e nada é enviado',()=>portalFixture({confirmText:'Deseja excluir esta pesquisa?'},async({driver,pdf,posts})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',2000),'not_submitted_held');
  assert.equal(posts(),0);
}));

test('CPI: radios de Resultado que não aparecem impedem anexar e enviar',()=>portalFixture({noRadios:true},async({driver,pdf,posts,attachedFile})=>{
  driver.timeouts={...driver.timeouts,fieldWait:300};
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',2000),'not_submitted_held');
  assert.equal(posts(),0);assert.equal(attachedFile(),null);
}));

test('CPI: troca do frame após leitura impede anexar e submeter',()=>portalFixture({},async({driver,page,pdf,posts})=>{
  await page.evaluate(()=>{
    const old=document.querySelector('#sb-content'),next=document.createElement('iframe');
    next.id='sb-content';next.src=old.src;old.replaceWith(next);
  });
  await page.locator('#sb-content').contentFrame().locator('input[type="file"]').waitFor();
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',500),'not_submitted_held');
  assert.equal(posts(),0);
}));

test('CPI: IDs alterados antes do upload impedem envio comprovadamente',()=>portalFixture({},async({driver,page,pdf,posts})=>{
  await page.locator('#sb-content').contentFrame().locator('h2').first().evaluate(node=>{node.textContent='Dados Solicitação 1275064';});
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',500),'not_submitted_held');
  assert.equal(posts(),0);
}));

test('CPI: identidade alterada durante preenchimento impede anexar PDF a outra pesquisa',()=>portalFixture({
  initial:editable().replace('<select name="id_pesquisador">','<select name="id_pesquisador" onchange="document.querySelector(\'h2\').textContent=\'Dados Solicitação 1275064\'">')
},async({driver,pdf,posts,attachedFile})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',500),'not_submitted_held');
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
  await assert.rejects(driver.finalizeSubmittedResponse(ids),/resposta não confirmada/);
  await driver.closeDetailWithoutSaving(ids);
  assert.equal(await modalVisible(page),false);assert.equal(posts(),0);
}));

// ---------- leitura do modal que falha: conta como aberto (fail-closed via modalOpen) ----------
/** A leitura de visibilidade do #sb-container rejeita `times` vezes (padrão: sempre); o resto do locator é real. */
function failModalReads(page,times=Infinity){
  const original=page.locator.bind(page);let left=times;
  page.locator=(selector,...rest)=>{
    const real=original(selector,...rest);
    if(selector!=='#sb-container')return real;
    const wrapped=Object.create(real);
    wrapped.isVisible=(...args)=>left-->0?Promise.reject(new Error('leitura indisponível')):real.isVisible(...args);
    return wrapped;
  };
  return ()=>{page.locator=original;};
}
test('CPI: leitura do modal que falha não dispensa a identidade: formulário de outra pesquisa não é fechado',()=>portalFixture({},async({driver,page,posts,closes})=>{
  const restore=failModalReads(page,1);
  await assert.rejects(driver.closeDetailWithoutSaving({pesquisaId:'999999',solicitacaoId:'888888'}),/não corresponde à pesquisa ensaiada/);
  restore();
  assert.equal(await closes(),0);assert.equal(await modalVisible(page),true);assert.equal(posts(),0);
}));
test('CPI: leitura do modal que falha não vira "já fechado": identidade conferida e fechamento pelo controle único',()=>portalFixture({},async({driver,page,posts,closes})=>{
  const restore=failModalReads(page);
  await driver.closeDetailWithoutSaving(ids);
  restore();
  assert.equal(await closes(),1);assert.equal(await modalVisible(page),false);assert.equal(posts(),0);
}));
test('CPI: leitura do modal que falha durante POST com HTTP 500 tardio não confirma o envio nem reenvia',()=>portalFixture({
  afterPost:async route=>{await new Promise(resolve=>setTimeout(resolve,2500));await route.fulfill({status:500,contentType:'text/html',body:'<h1>Erro de servidor no aplicativo</h1>'});}
},async({driver,page,pdf,posts})=>{
  const restore=failModalReads(page);
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',6000),'unverified');
  restore();
  assert.equal(posts(),1);
  await assert.rejects(driver.finalizeSubmittedResponse(ids),/resposta não confirmada/);
  await assert.rejects(driver.inspectPendingPersonDetails(ids),/Pendência operacional CPI/);
}));

// ---------- finalização: persistência (GET independente) → modal → listagem ----------
const confirmedReport=(extra={})=>({persistence:'confirmed',auxiliary404:false,modal:'closed',listing:'refreshed',browserReleased:true,...extra});
function refreshSpy(driver){const refreshed=[];driver.refreshAfterSave=async(_page,done)=>{refreshed.push(done);};return refreshed;}
/** Retenção operacional: nenhuma pesquisa abre até o modal sumir; fechar manualmente libera sem reabrir nada. */
async function assertHeldUntilManualClose(driver,page){
  await assert.rejects(driver.inspectPendingPersonDetails(ids),/Pendência operacional CPI/);
  await assert.rejects(driver.inspectPendingRows(),/Pendência operacional CPI/);
  await page.evaluate(()=>{document.getElementById('sb-container').style.display='none';});
  // Liberado: a recusa seguinte já é a regra normal (listagem não mapeada), não a pendência.
  await assert.rejects(driver.inspectPendingPersonDetails(ids),/não foi identificada e validada na listagem atual/);
  assert.equal(driver.operationalHold,null);
}

test('CPI: fluxo normal com fechamento automático: persistência lida por GET, nenhum clique em Fechar',()=>portalFixture({afterSave:'list',detailAfterPost:persisted()},async({driver,page,pdf,posts,probes,closes,pages})=>{
  const refreshed=refreshSpy(driver);
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000),'confirmed');
  assert.equal(await modalVisible(page),false);
  assert.deepEqual(await driver.finalizeSubmittedResponse(ids),confirmedReport({modal:'auto_closed'}));
  assert.equal(await closes(),0,'o portal já fechou: nenhum segundo fechamento');
  assert.deepEqual(refreshed,[ids]);
  assert.equal(probes(),1);assert.equal(posts(),1);assert.equal(pages(),1,'aba de conferência fechada');
  assert.equal(driver.operationalHold,null,'modal fechado pelo portal: navegador liberado');
  await assert.rejects(driver.finalizeSubmittedResponse(ids),/resposta não confirmada/);
}));

test('CPI: modal que permanece aberto após confirmação válida é fechado uma vez pelo controle Fechar',()=>portalFixture({detailAfterPost:persisted()},async({driver,page,pdf,posts,closes})=>{
  const refreshed=refreshSpy(driver);
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000),'confirmed');
  assert.equal(await modalVisible(page),true);
  assert.deepEqual(await driver.finalizeSubmittedResponse(ids),confirmedReport());
  assert.equal(await modalVisible(page),false);assert.equal(await closes(),1);
  assert.deepEqual(refreshed,[ids]);assert.equal(posts(),1);
}));

test('CPI: Sim, Consta Restrições só conclui com a mesma classificação exibida',()=>portalFixture({detailAfterPost:persisted({result:'restrictions'})},async({driver,pdf})=>{
  refreshSpy(driver);
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'restrictions',3000),'confirmed');
  assert.equal((await driver.finalizeSubmittedResponse(ids)).persistence,'confirmed');
}));

test('CPI: 404 auxiliar de cpi_api_request.aspx com persistência comprovada conclui com aviso',()=>portalFixture({afterSave:'aux404',detailAfterPost:persisted({aux404:true})},async({driver,page,pdf,posts,auxiliaryRequests})=>{
  refreshSpy(driver);
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000),'confirmed_auxiliary_404');
  assert.deepEqual(await driver.finalizeSubmittedResponse(ids),confirmedReport({auxiliary404:true}));
  assert.ok(auxiliaryRequests()>=1,'o recurso auxiliar respondeu 404 de fato');
  assert.equal(await modalVisible(page),false);assert.equal(posts(),1);
}));

test('CPI: 404 auxiliar com retorno automático à lista (iframe interno) não invalida o envio',()=>portalFixture({afterSave:'list_aux404',detailAfterPost:persisted()},async({driver,pdf,closes})=>{
  refreshSpy(driver);
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000),'confirmed_auxiliary_404');
  assert.deepEqual(await driver.finalizeSubmittedResponse(ids),confirmedReport({auxiliary404:true,modal:'auto_closed'}));
  assert.equal(await closes(),0);
}));

test('CPI: 404 auxiliar acompanhado de ausência real do Documento PDF não conclui e preserva o modal',()=>portalFixture({afterSave:'aux404',detailAfterPost:persisted({aux404:true,omit:'pdf'})},async({driver,page,pdf,posts,closes})=>{
  const refreshed=refreshSpy(driver);
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000),'confirmed_auxiliary_404');
  assert.deepEqual(await driver.finalizeSubmittedResponse(ids),{persistence:'absent',auxiliary404:true,modal:'not_attempted',listing:'not_attempted',browserReleased:false});
  assert.equal(await modalVisible(page),true);assert.equal(await closes(),0);
  assert.deepEqual(refreshed,[]);assert.equal(posts(),1);
  await assertHeldUntilManualClose(driver,page);assert.equal(posts(),1);
}));

for(const [name,detailAfterPost,classification] of [
  ['classificação divergente',persisted({result:'restrictions'}),'information'],
  ['fonte diferente de Desk Data',persisted({source:'Outra Fonte'}),'information'],
  ['sem data da resposta',persisted({omit:'timestamp'}),'information'],
  ['status ainda aguardando',persisted({status:'Aguardando Pesquisa'}),'information'],
  ['formulário editável (nada persistido)',editable(),'information']
]){
  test(`CPI: leitura independente com ${name} não conclui (absent), sem segundo envio`,()=>portalFixture({detailAfterPost},async({driver,pdf,posts})=>{
    refreshSpy(driver);
    assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,classification,3000),'confirmed');
    assert.equal((await driver.finalizeSubmittedResponse(ids)).persistence,'absent');
    assert.equal(posts(),1);
  }));
}

for(const [name,detailAfterPost] of [
  ['falha de rede',null],
  ['HTTP 500 no documento principal',{status:500,body:'<h1>Erro de servidor no aplicativo</h1>'}],
  ['outra pesquisa',persisted({target:{pesquisaId:'537988',solicitacaoId:'275064'}})],
  ['erro de servidor visível',persisted().replace('</body>','<div>Erro de Servidor no Aplicativo "/". URL solicitada: /upd_cad.aspx</div></body>')]
]){
  test(`CPI: leitura independente com ${name} fica indisponível (verificação manual), modal preservado`,()=>portalFixture({detailAfterPost},async({driver,page,pdf,posts})=>{
    refreshSpy(driver);
    assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000),'confirmed');
    const report=await driver.finalizeSubmittedResponse(ids);
    assert.equal(report.persistence,'unavailable');assert.equal(report.modal,'not_attempted');assert.equal(report.browserReleased,false);
    assert.equal(await modalVisible(page),true);assert.equal(posts(),1);
    await assert.rejects(driver.inspectPendingPersonDetails(ids),/Pendência operacional CPI/);
  }));
}

test('CPI: falha na atualização da listagem não altera a persistência confirmada',()=>portalFixture({detailAfterPost:persisted()},async({driver,pdf,posts})=>{
  driver.refreshAfterSave=async()=>{throw new Error('A CPI não confirmou a atualização da listagem após responder.');};
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000),'confirmed');
  assert.deepEqual(await driver.finalizeSubmittedResponse(ids),confirmedReport({listing:'stale'}));
  assert.equal(posts(),1);
}));

test('CPI: modal conflitante com persistência confirmada: não é fechado, navegador retido até o fechamento manual',()=>portalFixture({detailAfterPost:persisted()},async({driver,page,pdf,posts,probes,closes})=>{
  const refreshed=refreshSpy(driver);
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000),'confirmed');
  await page.evaluate(()=>{document.getElementById('sb-title-inner').firstChild.textContent='Outra janela ';});
  assert.deepEqual(await driver.finalizeSubmittedResponse(ids),confirmedReport({modal:'close_failed',listing:'not_attempted',browserReleased:false}));
  assert.equal(await closes(),0);assert.deepEqual(refreshed,[]);
  await assertHeldUntilManualClose(driver,page);
  // Nenhuma reabertura, POST, anexo ou nova leitura da resposta durante e depois da retenção.
  assert.equal(posts(),1);assert.equal(probes(),1);
  await assert.rejects(driver.finalizeSubmittedResponse(ids),/resposta não confirmada/);
}));

test('CPI: fechar o navegador encerra a retenção operacional (nova sessão)',()=>portalFixture({detailAfterPost:persisted()},async({driver,page,pdf})=>{
  refreshSpy(driver);
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000),'confirmed');
  await page.evaluate(()=>{document.getElementById('sb-title-inner').firstChild.textContent='Outra janela ';});
  assert.equal((await driver.finalizeSubmittedResponse(ids)).browserReleased,false);
  assert.ok(driver.operationalHold);
  driver.browser=null;driver.page=null;await driver.close();
  assert.equal(driver.operationalHold,null);
}));

test('CPI: prazo do fechamento do modal estourado não invalida a persistência confirmada',()=>portalFixture({detailAfterPost:persisted()},async({driver,pdf})=>{
  driver.timeouts={...driver.timeouts,closeDetail:200};
  driver.closeShadowbox=()=>new Promise(()=>{});
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000),'confirmed');
  assert.deepEqual(await driver.finalizeSubmittedResponse(ids),confirmedReport({modal:'close_failed',listing:'not_attempted',browserReleased:false}));
  await assert.rejects(driver.inspectPendingPersonDetails(ids),/Pendência operacional CPI/);
}));

test('CPI: leitura independente sem resposta no prazo fica indisponível',()=>portalFixture({detailAfterPost:persisted()},async({driver,pdf,posts})=>{
  driver.timeouts={...driver.timeouts,verifySave:200};
  driver.probePersisted=()=>new Promise(()=>{});
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',3000),'confirmed');
  assert.equal((await driver.finalizeSubmittedResponse(ids)).persistence,'unavailable');
  assert.equal(posts(),1);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { portalFixture, ids, persisted, origin, editable } from './helpers/cpi-portal.mjs';

test('CPI: modal fechado após HTTP 200 e confirm não comprova persistência',()=>portalFixture({
  afterPost:route=>route.fulfill({contentType:'text/html',body:'<script>parent.document.getElementById("sb-container").remove()</script>'})
},async({driver,pdf,posts})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',500),'unverified');
  assert.equal(posts(),1);
}));

test('CPI: POST 200 com erro de negócio não comprova persistência mesmo com campos de resposta',()=>portalFixture({
  saved:persisted()+'<div>Erro ao salvar: operação rejeitada.</div>'
},async({driver,pdf,posts})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',500),'unverified');
  assert.equal(posts(),1);
}));

test('CPI: POST redirecionado ao login não conclui a pesquisa',()=>portalFixture({
  afterPost:route=>route.fulfill({status:302,headers:{location:origin+'/acesso/checkUser.aspx'},body:''})
},async({driver,pdf,posts})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',500),'unverified');
  assert.equal(posts(),1);
}));

test('CPI: resposta persistida confirma IDs, classificação e o PDF selecionado',()=>portalFixture({result:'restrictions'},async({driver,pdf,posts,body,attachedFile})=>{
  const before=await readFile(pdf);
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'restrictions',2000),'confirmed');
  assert.equal(posts(),1);
  assert.ok(body().includes(Buffer.from('report.pdf')));
  assert.ok(body().includes(Buffer.from('restrictions')));
  assert.deepEqual(attachedFile(),before);
  assert.deepEqual(await readFile(pdf),before);
}));

function stepRecorder(){
  const steps=[];
  return {steps,timer:{begin:step=>{let done=false;return state=>{if(!done){done=true;steps.push(`${step}:${state}`);}};}}};
}

test('CPI: tempos de abrir detalhe, ler CPF, preencher, anexar e salvar são medidos em etapas separadas',()=>portalFixture({},async({driver,pdf})=>{
  const {steps,timer}=stepRecorder();
  await driver.inspectPendingPersonDetails(ids,timer);
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',2000,timer),'confirmed');
  assert.deepEqual(steps,['cpi_open_detail:success','cpi_read_cpf:success','cpi_fill:success','cpi_attach:success','cpi_save:success']);
}));

test('CPI: salvamento sem confirmação encerra a etapa de salvar como falha',()=>portalFixture({
  afterPost:route=>route.fulfill({status:302,headers:{location:origin+'/acesso/checkUser.aspx'},body:''})
},async({driver,pdf})=>{
  const {steps,timer}=stepRecorder();
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',500,timer),'unverified');
  assert.deepEqual(steps,['cpi_fill:success','cpi_attach:success','cpi_save:failed']);
}));

for(const target of [{...ids,pesquisaId:'1537987'},{...ids,solicitacaoId:'1275064'}]){
  test(`CPI: IDs com prefixos comuns não confirmam ${target.pesquisaId}/${target.solicitacaoId}`,()=>portalFixture({saved:persisted({target})},async({driver,pdf,posts})=>{
    assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',500),'unverified');
    assert.equal(posts(),1);
  }));
}

test('CPI: título ambíguo não é aceito por fallback de substring do corpo',()=>portalFixture({
  saved:persisted().replace('Dados Solicitação 275064','Dados Solicitação 275064 / 275065')
},async({driver,pdf})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',500),'unverified');
}));

test('CPI: evidência de outro frame não completa a resposta do formulário submetido',()=>portalFixture({
  extraFrame:'<iframe src="/other"></iframe>',pages:{'/other':persisted()},
  saved:'<html><body>Erro ao salvar: operação rejeitada.</body></html>'
},async({driver,pdf})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',500),'unverified');
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
  initial:editable().replace('<select name="source">','<select name="source" onchange="window.document.querySelector(\'h2\').textContent=\'Dados Solicitação 1275064\'">')
},async({driver,pdf,posts,attachedFile})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',500),'not_submitted');
  assert.equal(posts(),0);assert.equal(attachedFile(),null);
}));

for(const omit of ['timestamp','pdf','source']){
  test(`CPI: campo persistido ausente (${omit}) mantém resultado incerto`,()=>portalFixture({omit},async({driver,pdf})=>{
    assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',500),'unverified');
  }));
}

test('CPI: fonte persistida divergente não conclui a pesquisa',()=>portalFixture({source:'Outra'},async({driver,pdf})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',500),'unverified');
}));

test('CPI: classificação persistida divergente mantém resultado incerto',()=>portalFixture({result:'information'},async({driver,pdf})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'restrictions',500),'unverified');
}));

for(const [name,from,to] of [
  ['resultado negado','Há Informações','Não há informações'],
  ['documento negado','Documento PDF','Sem documento PDF'],
  ['data inválida','11/11/2026','99/99/0000']
]){
  test(`CPI: ${name} não é evidência positiva`,()=>portalFixture({saved:persisted().replace(from,to)},async({driver,pdf})=>{
    assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',500),'unverified');
  }));
}

test('CPI: POST 200 seguido de GET na mesma URL não confirma o documento do POST',()=>portalFixture({
  initial:editable(),afterPost:route=>route.fulfill({contentType:'text/html',body:'<script>location.replace(location.href)</script>'}),
  pages:{'/zpersEspecial/pesquisas/upd_cad/mod_tt_pesq_upd.aspx':posts=>posts?persisted():editable()}
},async({driver,pdf})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',700),'unverified');
}));

for(const change of ['navigation','alert']){
  test(`CPI: ${change} durante leitura da evidência invalida o snapshot`,()=>portalFixture({},async({driver,pdf})=>{
    const original=driver.savedResponseEvidence.bind(driver);
    driver.savedResponseEvidence=async(...args)=>{
      const evidence=await original(...args);
      if(evidence){
        if(change==='navigation')await args[0].goto(args[0].url());
        else await args[0].evaluate(()=>alert('Erro ao salvar'));
      }
      return evidence;
    };
    assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',2000),'unverified');
  }));
}

test('CPI: POST disparado durante preenchimento torna a falha posterior incerta',()=>portalFixture({
  initial:editable().replace('<select name="source">','<select name="source" onchange="this.form.submit()">')
},async({driver,pdf,posts})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',500),'unverified');
  assert.equal(posts(),1);
}));

test('CPI: erro de conexão após submissão não autoriza repetir',()=>portalFixture({
  afterPost:route=>route.abort('connectionreset')
},async({driver,pdf,posts})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',500),'unverified');
  assert.equal(posts(),1);
}));

test('CPI: POST de outro formulário no mesmo frame não é a resposta correlacionada',()=>portalFixture({
  initial:editable().replace('type="submit" onclick="return confirm(\'Deseja alterar esta pesquisa?\')"',
    'type="button" onclick="if(confirm(\'Deseja alterar esta pesquisa?\')){this.form.action=\'/unrelated\';this.form.submit()}"')
},async({driver,pdf,posts})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',500),'unverified');
  assert.equal(posts(),1);
}));

test('CPI: 404 auxiliar conhecido não substitui nem invalida evidência positiva completa',()=>portalFixture({
  saved:persisted()+'<div>Erro de Servidor no Aplicativo. Nao e possivel encontrar o recurso. HTTP 404. URL solicitada: /cpi_api_request.aspx</div>'
},async({driver,pdf})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',2000),'confirmed_auxiliary_404');
}));

test('CPI: template homologado fora de h2 usa os mesmos IDs no upload e confirmação',()=>portalFixture({
  legacy:true,saved:persisted({legacy:true})
},async({driver,pdf,posts})=>{
  assert.equal(await driver.uploadAndSavePersonResponse(ids,pdf,'information',2000),'confirmed');
  assert.equal(posts(),1);
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

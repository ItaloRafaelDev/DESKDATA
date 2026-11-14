import { chromium } from 'playwright-core';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CpiBrowser } from '../../src/main/cpi/cpi-browser.ts';

/**
 * Portal CPI simulado para testes do formulário "Responder / Atualizar Pesquisa".
 * Modela os seletores do projeto AGENTE_PESQUISA_FORUM_NACIONAL, em uso no portal real
 * (id_pesquisador, id_pesq_status, #consta1..3 surgindo após o Status, #MainPage_FileUpload1,
 * a.button com upd_pesq e confirm nativo). NÃO é homologação do portal: a validação real é manual.
 */
export const ids={pesquisaId:'537987',solicitacaoId:'275064'};
export const origin='https://adm.cpicentral.com.br';
export const detailUrl=`${origin}/zpersEspecial/pesquisas/upd_cad/mod_tt_pesq_upd.aspx?id_sol=${ids.solicitacaoId}&id_pesq_tipo=${ids.pesquisaId}`;
const row=(label,value)=>`<div class="row"><div class="cell txt">${label}:</div><div class="cell field">${value}</div></div>`;
export function headings(target=ids,legacy=false){
  return legacy?`<div class="mt">Dados da Solicitação: ${target.solicitacaoId}</div><h3>Dados da Pesquisa: ${target.pesquisaId}</h3>`
    :`<h2>Dados Solicitação ${target.solicitacaoId}</h2><h2>Dados da Pesquisa - ${target.pesquisaId}</h2>`;
}
const sources=`<option value="INDEF">* Indefinido *</option><option value="DESKDATA">Desk Data</option><option value="OUTRA">Outra Fonte</option>`;
const radios=`<input type="radio" name="consta" id="consta0" value="C0"><label for="consta0">Indefinido</label>`+
  `<input type="radio" name="consta" id="consta1" value="C1"><label for="consta1">Nada Consta</label>`+
  `<input type="radio" name="consta" id="consta2" value="C2"><label for="consta2">Há Informações</label>`+
  `<input type="radio" name="consta" id="consta3" value="C3"><label for="consta3">Sim, Consta Restrições</label>`;
/**
 * @param {object} o
 * @param {boolean} [o.statusReloads] a troca de Status zera a Fonte antes de exibir os radios (postback simulado)
 * @param {boolean} [o.noRadios] os radios nunca aparecem
 * @param {string} [o.confirmText] mensagem do confirm do botão Alterar
 * @param {boolean} [o.keepChecked] "Permanecer nesta tela" começa marcado
 */
export function editable({legacy=false,target=ids,statusReloads=false,noRadios=false,keepChecked=false,
  confirmText='Deseja Realmente Alterar esta Pesquisa?'}={}){
  return `<html><head><meta charset="utf-8"></head><body>${headings(target,legacy)}
  <form name="form_cad" method="post" action="${detailUrl}" enctype="multipart/form-data">
    ${row('CPF','529.982.247-25')}${row('Pesquisa','PROCESSOS JUDICIAIS CRIMINAL FORUM NACIONAL CPF')}
    ${row('Pesquisador/Fonte',`<select name="id_pesquisador">${sources}</select>`)}
    ${row('Pesquisador/Fonte 1º',`<select name="id_pesquisador_prim">${sources}</select>`)}
    ${row('Status','<select name="id_pesq_status" onchange="mudouStatus()"><option value="AGUARDANDO">Aguardando Pesquisa</option><option value="RESPONDIDA">Respondida</option></select>')}
    ${row('Resultado','<span id="resultado"></span>')}
    ${row('Em Arquivo','<input type="file" name="ctl00$MainPage$FileUpload1" id="MainPage_FileUpload1">')}
    <div class="row"><input type="checkbox" id="chkPermanecer" name="permanecer" value="1"${keepChecked?' checked':''}><label for="chkPermanecer">Permanecer nesta tela</label></div>
    <div class="pa ac"><a class="button" href="javascript:void(0)" onclick="upd_pesq()">Alterar</a></div>
  </form>
  <script>
    function mudouStatus(){
      setTimeout(function(){
        ${statusReloads?"if(!window.__recarregou){window.__recarregou=true;document.querySelector('[name=id_pesquisador]').selectedIndex=0;}":''}
        ${noRadios?'':`if(!document.getElementById('consta2'))document.getElementById('resultado').innerHTML=${JSON.stringify(radios)};`}
      },150);
    }
    function upd_pesq(){
      var marcado=document.querySelector('input[name=consta]:checked');
      if(confirm(${JSON.stringify(confirmText)}+'\\nResultado >>> '+(marcado?marcado.nextElementSibling.textContent:'')))document.forms.form_cad.submit();
    }
  </script></body></html>`;
}
/** Página de erro observada no portal real para o recurso auxiliar (ASP.NET, HTTP 404). */
export const auxiliary404Html='<div class="erro-aux">404;404; Erro de Servidor no Aplicativo "/". Não é possível encontrar o recurso. '+
  'Descrição: HTTP 404. URL solicitada: /cpi_api_request.aspx</div>';
/**
 * Resposta salva em modo leitura. `aux404`: exibe o erro 404 do recurso auxiliar e o requisita de fato.
 * `status`: 'Respondida' por padrão; `result`: classificação exibida.
 */
export function persisted({target=ids,legacy=false,result='information',omit,source='Desk Data',status='Respondida',aux404=false}={}){
  return `<html><head><meta charset="utf-8"></head><body>${headings(target,legacy)}${row('Status',status)}
    ${omit==='source'?'':row('Pesquisador/Fonte',source)}
    ${row('Resultado',result==='restrictions'?'Sim, Consta Restrições':'Há Informações')}
    ${omit==='timestamp'?'':row('Respondida em','11/11/2026 10:30:00')}
    ${omit==='pdf'?'':row('Em arquivo','Documento PDF')}
    ${aux404?`${auxiliary404Html}<script>fetch('/cpi_api_request.aspx').catch(function(){})</script>`:''}</body></html>`;
}
/** Valor de um campo simples no corpo multipart do POST (null se ausente). */
export function postedField(body,name){
  if(!body)return null;
  const match=body.toString('latin1').match(new RegExp(`name="${name.replace(/[$]/g,'\\$&')}"\\r\\n\\r\\n([^\\r]*)\\r\\n`));
  return match?match[1]:null;
}
const afterSavePages={
  modal_open:'<html><body><h2>Pesquisa alterada</h2></body></html>',
  list:'<html><body><script>parent.document.getElementById("sb-container").style.display="none"</script></body></html>',
  error_alert:'<html><body><script>alert("Erro ao gravar a pesquisa")</script></body></html>',
  error_text:'<html><body><div>Erro ao salvar: operação rejeitada.</div></body></html>',
  // Resposta do POST com o 404 auxiliar visível e requisitado; o modal continua aberto.
  aux404:`<html><head><meta charset="utf-8"></head><body><h2>Pesquisa alterada</h2>${auxiliary404Html}<script>fetch('/cpi_api_request.aspx').catch(function(){})</script></body></html>`,
  // O mesmo 404 auxiliar, mas o portal volta sozinho para a lista.
  list_aux404:`<html><head><meta charset="utf-8"></head><body>${auxiliary404Html}<iframe src="/cpi_api_request.aspx"></iframe><script>parent.document.getElementById("sb-container").style.display="none"</script></body></html>`
};

/**
 * Todos os requests são respondidos localmente; nenhuma rota usa continue/fetch.
 * options.afterSave: 'modal_open' (padrão) | 'list' | 'aux404' | 'list_aux404' | 'error_alert' | 'error_text' | 'login' | 'http500'
 * options.detailAfterPost: HTML devolvido ao GET do detalhe depois de um POST (leitura independente);
 *   ausente = o formulário editável continua sendo servido (nada persistido). Função recebe o nº de GETs.
 */
export async function portalFixture(options,run){
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const dir=await mkdtemp(join(tmpdir(),'deskdata-cpi-confirmation-'));
  const pdf=join(dir,'CPI_537987_275064_2026-11-13.pdf');
  await writeFile(pdf,'%PDF-1.4\n'+'fixture'.repeat(30));
  const context=await browser.newContext({serviceWorkers:'block'});
  let posts=0,postedBody=null,attachedFile=null,probes=0,auxiliaryRequests=0;
  await context.exposeBinding('captureFixtureUpload',(_source,bytes)=>{attachedFile=Buffer.from(bytes);});
  await context.addInitScript(()=>{
    document.addEventListener('change',event=>{
      const file=event.target?.type==='file'?event.target.files?.[0]:null;
      if(file)void file.arrayBuffer().then(buffer=>globalThis.captureFixtureUpload(Array.from(new Uint8Array(buffer))));
    },true);
  });
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(request.method()==='POST'){
      posts++;postedBody=request.postDataBuffer();
      if(options.afterPost)return options.afterPost(route);
      const mode=options.afterSave??'modal_open';
      if(mode==='login')return route.fulfill({status:302,headers:{location:origin+'/acesso/checkUser.aspx'},body:''});
      if(mode==='http500')return route.fulfill({status:500,contentType:'text/html',body:'<h1>Erro de servidor no aplicativo</h1>'});
      return route.fulfill({status:200,contentType:'text/html',body:options.saved??afterSavePages[mode]});
    }
    if(url.pathname==='/cpi_api_request.aspx'){
      auxiliaryRequests++;
      // options.auxiliaryStatus: status do recurso auxiliar (404 observado no portal real; outro valor = condição não observada).
      return route.fulfill({status:options.auxiliaryStatus??404,contentType:'text/html',body:`<html><body>${auxiliary404Html}</body></html>`});
    }
    if(url.pathname==='/fixture-list')return route.fulfill({contentType:'text/html',body:
      `<div id="sb-container"><div id="sb-title-inner">Responder / Atualizar Pesquisa <a title="Fechar" onclick="Shadowbox.close()">x</a></div>`+
      `<iframe id="sb-content" src="${detailUrl}"></iframe></div>${options.extraFrame??''}`+
      `<script>window.__closes=0;var Shadowbox={close:function(){window.__closes++;document.getElementById('sb-container').style.display='none';}};</script>`});
    if(posts>0&&options.detailAfterPost!==undefined&&url.pathname===new URL(detailUrl).pathname){
      probes++;
      const page=typeof options.detailAfterPost==='function'?options.detailAfterPost(probes):options.detailAfterPost;
      if(page===null)return route.abort('connectionrefused');
      return route.fulfill(typeof page==='string'?{contentType:'text/html',body:page}:{contentType:'text/html',...page});
    }
    if(url.pathname==='/acesso/checkUser.aspx')return route.fulfill({contentType:'text/html',body:'<input type="password">Login'});
    if(options.pages?.[url.pathname]){
      const page=options.pages[url.pathname];
      return route.fulfill({contentType:'text/html',body:typeof page==='function'?page(posts):page});
    }
    return route.fulfill({contentType:'text/html',body:options.initial??editable(options)});
  });
  const page=await context.newPage();
  const driver=new CpiBrowser();
  // Injeção da fronteira de navegador: exercita o adaptador real sem lançar sessão CPI.
  driver.browser=browser;driver.page=page;driver.lastMappedRows=[ids];
  try{
    await page.goto(`${origin}/fixture-list`);
    await page.locator('#sb-content').contentFrame().locator('input[type="file"]').waitFor();
    await driver.inspectPendingPersonDetails(ids);
    await run({driver,page,pdf,posts:()=>posts,body:()=>postedBody,attachedFile:()=>attachedFile,
      probes:()=>probes,auxiliaryRequests:()=>auxiliaryRequests,closes:()=>page.evaluate(()=>window.__closes),
      pages:()=>page.context().pages().length});
  }finally{await context.close();await browser.close();await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
}

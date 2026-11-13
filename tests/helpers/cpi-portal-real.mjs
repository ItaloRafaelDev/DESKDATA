import { chromium } from 'playwright-core';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CpiBrowser } from '../../src/main/cpi/cpi-browser.ts';
import { headings } from './cpi-portal.mjs';

/**
 * Simulador do portal CPI com o DOM capturado em 13/11 (E6). Dados fictícios; todas as rotas são locais.
 * Listagem: checkbox #pesq_N com value "1;<solicitacaoId>;<pesquisaId>", "Mostrar Tudo" e Shadowbox com
 * iframe#sb-content e a#sb-nav-close. Modal: selects id_pesquisador / id_pesquisador_prim / id_pesq_status;
 * change_status() revela os radios consta, o editor e o input #MainPage_FileUpload1; #stay; link "Alterar"
 * (upd_pesq) com confirm() nativo e texto "Carregando..." durante o envio.
 */
export const ids={pesquisaId:'542685',solicitacaoId:'277705'};
export const origin='https://adm.cpicentral.com.br';
export const listingPath='/zpersEspecial/pesquisas/aguardando/mod_t_aguardando.aspx';
export const detailPath='/zpersEspecial/pesquisas/upd_cad/mod_tt_pesq_upd.aspx';
export const detailUrl=`${origin}${detailPath}?id_sol=${ids.solicitacaoId}&id_pesq_tipo=${ids.pesquisaId}`;
export const pdfName=`CPI_${ids.pesquisaId}_${ids.solicitacaoId}_2026-11-13.pdf`;
const row=(label,value)=>`<div class="row"><div class="cell">${label}:</div><div class="cell">${value}</div></div>`;

function listing(){
  return `<html><head><meta charset="utf-8"><script>
  window.Shadowbox={close(){document.getElementById('sb-container').style.display='none';}};
  window.__saved=function(keepRow,keepOpen){
    if(!keepRow){document.getElementById('linha').remove();document.getElementById('rodape').textContent='Mostrando: 0 à 0 ( de 0 registros )';}
    if(!keepOpen)Shadowbox.close();
  };
  </script></head><body>
  <a href="javascript://" title="Mostrar Tudo" onclick="void 0">olho</a>
  <table><tr id="linha"><td><input type="checkbox" id="pesq_1" name="pesq_1" value="1;${ids.solicitacaoId};${ids.pesquisaId}"></td></tr></table>
  <div id="rodape">Mostrando: 1 à 1 ( de 1 registro )</div>
  <div id="sb-container"><a id="sb-nav-close" onclick="Shadowbox.close()" href="javascript://">x</a>
  <iframe id="sb-content" name="sb-content" src="${detailUrl}"></iframe></div>
  </body></html>`;
}

/** `options`: confirmText, stayChecked, beforeClickScript (código em change_consta), keepRow, keepOpen, postStatus, legacy (cabeçalhos homologados fora de h2), abortSave (conexão cai no envio). */
export function detail(options={}){
  const confirmExpr=options.confirmText?JSON.stringify(options.confirmText)
    :`'Deseja Realmente Alterar esta Pesquisa?\\nResultado >>> '+rotulo()`;
  return `<html><head><meta charset="utf-8"></head><body>${headings(ids,!!options.legacy)}
  <input type="hidden" name="id_sol" value="${ids.solicitacaoId}"><input type="hidden" name="id_pesq_tipo" value="${ids.pesquisaId}">
  ${row('CPF','529.982.247-25')}${row('Pesquisa','PROCESSOS JUDICIAIS CRIMINAL FORUM NACIONAL CPF')}
  ${row('Pesquisador/Fonte','<select name="id_pesquisador"><option value="">Selecione</option><option value="7">Desk Data</option></select>')}
  ${row('Pesquisador/Fonte 1º','<select name="id_pesquisador_prim"><option value="">Selecione</option><option value="7">Desk Data</option></select>')}
  ${row('Status','<select name="id_pesq_status" onchange="javascript:change_status();"><option value="1">Aguardando Pesquisa</option><option value="3">Respondida</option></select>')}
  <div id="bloco" style="display:none">
    ${row('Resultado',`<input type="radio" name="consta" id="consta0" value="0" onchange="javascript:change_consta();"><label for="consta0">Nada Consta</label>
      <input type="radio" name="consta" id="consta1" value="1" onchange="javascript:change_consta();"><label for="consta1">Outro</label>
      <input type="radio" name="consta" id="consta2" value="2" onchange="javascript:change_consta();"><label for="consta2">Há Informações</label>
      <input type="radio" name="consta" id="consta3" value="3" onchange="javascript:change_consta();"><label for="consta3">Sim, Consta Restrições</label>`)}
    <textarea id="resposta" name="resposta"></textarea>
    ${row('Em arquivo','<input type="file" id="MainPage_FileUpload1" name="ctl00$MainPage$FileUpload1" accept=".pdf">')}
  </div>
  <input type="checkbox" id="stay" name="stay"${options.stayChecked?' checked':''}><label for="stay">Permanecer nesta tela</label>
  <a href="javascript://" id="alterar" onclick="javascript:upd_pesq();">Alterar</a>
  <a onclick="Shadowbox.close()">Cancelar</a>
  <script>
  function change_status(){document.getElementById('bloco').style.display=document.querySelector('[name=id_pesq_status]').selectedOptions[0].text==='Respondida'?'block':'none';}
  function change_consta(){${options.beforeClickScript??''}}
  function rotulo(){const c=document.querySelector('input[name=consta]:checked');return c?document.querySelector('label[for='+c.id+']').textContent:'';}
  function upd_pesq(){
    if(!confirm(${confirmExpr}))return;
    document.getElementById('alterar').textContent='Carregando...';
    const data=new FormData();
    data.append('upd','1');data.append('consta',document.querySelector('input[name=consta]:checked')?.value??'');
    data.append('id_pesquisador',document.querySelector('[name=id_pesquisador]').value);
    data.append('id_pesquisador_prim',document.querySelector('[name=id_pesquisador_prim]').value);
    data.append('resposta',document.getElementById('resposta').value);
    data.append('stay',document.getElementById('stay').checked?'1':'0');
    const file=document.getElementById('MainPage_FileUpload1').files[0];if(file)data.append('arquivo',file);
    fetch(location.href,{method:'POST',body:data}).then(r=>{if(r.ok)parent.__saved(${!!options.keepRow},${!!options.keepOpen});});
  }
  </script></body></html>`;
}

/** Portal simulado: `saves()` conta só o envio do formulário (POST com upd=1); `requests()` lista o resto. */
export async function realPortalFixture(options,run){
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const dir=await mkdtemp(join(tmpdir(),'deskdata-cpi-real-'));
  const pdf=join(dir,pdfName);
  await writeFile(pdf,'%PDF-1.4\n'+'fixture'.repeat(30));
  const context=await browser.newContext({serviceWorkers:'block'});
  const saves=[],requests=[];let detailLoads=0;
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(request.method()==='POST'&&url.pathname===detailPath){
      const body=request.postDataBuffer()?.toString('latin1')??'';
      if(/name="upd"\r\n\r\n1/.test(body)){saves.push(body);if(options.abortSave)return route.abort('connectionreset');return route.fulfill({status:options.postStatus??200,contentType:'text/plain',body:'ok'});}
    }
    if(url.pathname===listingPath)return route.fulfill({contentType:'text/html',body:listing()});
    if(url.pathname===detailPath&&request.method()==='GET'){detailLoads++;return route.fulfill({contentType:'text/html',body:detail(options)});}
    requests.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({status:200,contentType:'text/plain',body:'ok'});
  });
  const page=await context.newPage();
  const driver=new CpiBrowser();
  const diagnostics=[];
  driver.setDiagnostics((event,fields)=>diagnostics.push({event,...fields}));
  // Injeção da fronteira de navegador: exercita o adaptador real sem lançar sessão CPI.
  driver.browser=browser;driver.page=page;driver.lastMappedRows=[ids];
  try{
    await page.goto(`${origin}${listingPath}`);
    await page.locator('#sb-content').contentFrame().locator('select[name=id_pesq_status]').waitFor({state:'attached'});
    await driver.inspectPendingPersonDetails(ids);
    const frame=()=>page.locator('#sb-content').contentFrame();
    await run({driver,page,frame,pdf,saves:()=>saves,requests:()=>requests,diagnostics,detailLoads:()=>detailLoads,
      modalVisible:()=>page.locator('#sb-container').isVisible(),
      rowListed:()=>page.locator(`input[type=checkbox][value="1;${ids.solicitacaoId};${ids.pesquisaId}"]`).count().then(n=>n>0)});
  }finally{await context.close();await browser.close();await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
}

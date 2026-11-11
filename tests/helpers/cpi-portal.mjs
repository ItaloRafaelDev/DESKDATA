import { chromium } from 'playwright-core';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CpiBrowser } from '../../src/main/cpi/cpi-browser.ts';

export const ids={pesquisaId:'537987',solicitacaoId:'275064'};
export const origin='https://adm.cpicentral.com.br';
export const detailUrl=`${origin}/zpersEspecial/pesquisas/upd_cad/mod_tt_pesq_upd.aspx?id_sol=${ids.solicitacaoId}&id_pesq_tipo=${ids.pesquisaId}`;
const row=(label,value)=>`<div class="row"><div class="cell">${label}:</div><div class="cell">${value}</div></div>`;
export function headings(target=ids,legacy=false){
  return legacy?`<div class="mt">Dados da Solicitação: ${target.solicitacaoId}</div><h3>Dados da Pesquisa: ${target.pesquisaId}</h3>`
    :`<h2>Dados Solicitação ${target.solicitacaoId}</h2><h2>Dados da Pesquisa - ${target.pesquisaId}</h2>`;
}
export function editable({legacy=false,target=ids,action=detailUrl}={}){
  return `<html><head><meta charset="utf-8"></head><body>${headings(target,legacy)}<form method="post" action="${action}" enctype="multipart/form-data">
    ${row('CPF','529.982.247-25')}${row('Pesquisa','PROCESSOS JUDICIAIS CRIMINAL FORUM NACIONAL CPF')}
    ${row('Pesquisador/Fonte','<select name="source"><option>Outra</option><option>Desk Data</option></select>')}
    ${row('Status','<select name="status"><option>Aguardando Pesquisa</option><option>Respondida</option></select>')}
    ${row('Resultado','<input id="info" name="result" value="information" type="radio"><label for="info">Há Informações</label><input id="restrictions" name="result" value="restrictions" type="radio"><label for="restrictions">Sim, Consta Restrições</label>')}
    <input type="file" accept=".pdf" name="document"><button type="submit" onclick="return confirm('Deseja alterar esta pesquisa?')">Alterar</button>
    </form></body></html>`;
}
export function persisted({target=ids,legacy=false,result='information',omit,source='Desk Data'}={}){
  return `<html><head><meta charset="utf-8"></head><body>${headings(target,legacy)}${row('Status','Respondida')}
    ${omit==='source'?'':row('Pesquisador/Fonte',source)}
    ${row('Resultado',result==='restrictions'?'Sim, Consta Restrições':'Há Informações')}
    ${omit==='timestamp'?'':row('Respondida em','11/11/2026 10:30:00')}
    ${omit==='pdf'?'':row('Em arquivo','Documento PDF')}</body></html>`;
}

/** Todos os requests são respondidos localmente; nenhuma rota usa continue/fetch. */
export async function portalFixture(options,run){
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const dir=await mkdtemp(join(tmpdir(),'deskdata-cpi-confirmation-'));
  const pdf=join(dir,'report.pdf');
  await writeFile(pdf,'%PDF-1.4\n'+'fixture'.repeat(30));
  const context=await browser.newContext({serviceWorkers:'block'});
  let posts=0,postedBody=null,attachedFile=null;
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
      return route.fulfill({status:200,contentType:'text/html',body:options.saved??persisted(options)});
    }
    if(url.pathname==='/fixture-list')return route.fulfill({contentType:'text/html',body:
      `<div id="sb-container"><iframe id="sb-content" src="${detailUrl}"></iframe></div>${options.extraFrame??''}`});
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
    await run({driver,page,pdf,posts:()=>posts,body:()=>postedBody,attachedFile:()=>attachedFile});
  }finally{await context.close();await browser.close();await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
}

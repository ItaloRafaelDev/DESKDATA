import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PRINT_CSP, PDF_RENDER_TIMEOUT_MS, renderAndSave, withPrintCsp } from '../src/main/pdf-render.ts';
import { renderReportHtml } from '../src/shared/report.ts';
import { normalizeDeskdataResponse } from '../src/shared/normalizer.ts';
import { normalizePisResult, renderPisPdfHtml } from '../src/shared/pis-report.ts';
import { normalizeCompanyResponse, renderCompanyHtml } from '../src/shared/company-report.ts';

const cpf='52998224725';
const META=`<meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">`;
const empty=(...keys)=>Object.fromEntries(keys.map(key=>[key,{items:[]}]));
const templates={
 pessoa:()=>renderReportHtml({cpf,consultedAt:'2026-11-11T12:00:00Z',data:normalizeDeskdataResponse({status:{code:4000},data:{basic:{name:'PESSOA FICTÍCIA',cpf},...empty('phones','addresses','emails','lawsuits')}})}),
 pis:()=>renderPisPdfHtml(normalizePisResult({status:{code:4000},data:{basic:{name:{full_name:'Pessoa Fictícia'},tax_id:{number:cpf,status:'REGULAR'},social_security:{number:'14265531608'}}}},cpf)),
 cnpj:()=>renderCompanyHtml(normalizeCompanyResponse({status:{code:4000},data:{basic:{legal_name:'EMPRESA FICTÍCIA',tax_id:{number:'11222333000181'}},...empty('phones','addresses','emails','relationships','lawsuits')}}),'11222333000181','2026-11-11T12:00:00Z')
};

async function withFolder(callback){const folder=await mkdtemp(join(tmpdir(),'deskdata-pdf-'));try{await callback(folder);}finally{await rm(folder,{recursive:true,force:true});}}
function fakeWindow({printToPDF=async()=>Buffer.from('%PDF-1.7\n')}={}){
 const calls={written:'',destroyed:0};let destroyed=false;
 const window={calls,isDestroyed:()=>destroyed,destroy:()=>{destroyed=true;calls.destroyed++;},loadURL:async()=>{},
  webContents:{executeJavaScript:async code=>{if(code.startsWith('document.open'))calls.written=code;return true;},printToPDF}};
 return window;
}

test('timeout padrão da geração do PDF é 120 s',()=>{assert.equal(PDF_RENDER_TIMEOUT_MS,120_000);});

test('regeração no mesmo dia recebe sufixo -NN sem sobrescrever o arquivo anterior',async()=>withFolder(async folder=>{
 const first=await renderAndSave(()=>fakeWindow({printToPDF:async()=>Buffer.from('%PDF-1.7\nprimeiro')}),folder,templates.pessoa(),'CPI_537987_275064_2026-11-12','Q-ABCDEF0123',1000);
 const second=await renderAndSave(()=>fakeWindow({printToPDF:async()=>Buffer.from('%PDF-1.7\nsegundo')}),folder,templates.pessoa(),'CPI_537987_275064_2026-11-12','Q-ABCDEF0123',1000);
 assert.equal(basename(first.path),'CPI_537987_275064_2026-11-12.pdf');
 assert.equal(basename(second.path),'CPI_537987_275064_2026-11-12-02.pdf');
 assert.equal(await readFile(first.path,'utf8'),'%PDF-1.7\nprimeiro');
 assert.equal(await readFile(second.path,'utf8'),'%PDF-1.7\nsegundo');
}));

test('sufixo fica em -NN: após -99 a geração falha sem gravar -100',async()=>withFolder(async folder=>{
 await writeFile(join(folder,'CPI_537987_275064_2026-11-12.pdf'),'x');
 for(let i=2;i<=99;i++)await writeFile(join(folder,`CPI_537987_275064_2026-11-12-${String(i).padStart(2,'0')}.pdf`),'x');
 await assert.rejects(renderAndSave(()=>fakeWindow(),folder,templates.pessoa(),'CPI_537987_275064_2026-11-12','Q-ABCDEF0123',1000),/Limite/);
 assert.equal((await readdir(folder)).length,99);
}));

test('printToPDF que nunca resolve: destrói a janela, lança erro e não grava arquivo',async()=>withFolder(async folder=>{
 const window=fakeWindow({printToPDF:()=>new Promise(()=>{})});
 await assert.rejects(renderAndSave(()=>window,folder,templates.pessoa(),'RELATORIO_Q-ABCDEF0123_2026-11-11','Q-ABCDEF0123',50),/excedeu .* cancelada\. Nenhum arquivo foi gravado\./);
 assert.equal(window.isDestroyed(),true);assert.equal(window.calls.destroyed,1);
 assert.deepEqual(await readdir(folder),[]);
}));

test('document.write travado também é coberto pelo timeout',async()=>withFolder(async folder=>{
 const window=fakeWindow();window.webContents.executeJavaScript=()=>new Promise(()=>{});
 await assert.rejects(renderAndSave(()=>window,folder,'<html><head></head><body></body></html>','RELATORIO_X',undefined,50),/excedeu/);
 assert.equal(window.isDestroyed(),true);assert.deepEqual(await readdir(folder),[]);
}));

test('geração normal grava o PDF, envia HTML com CSP e destrói a janela',async()=>withFolder(async folder=>{
 const window=fakeWindow();
 const result=await renderAndSave(()=>window,folder,templates.pis(),'PIS_Q-ABCDEF0124_2026-11-11','Q-ABCDEF0124',1000);
 assert.equal(result.queryCode,'Q-ABCDEF0124');assert.deepEqual(await readdir(folder),['PIS_Q-ABCDEF0124_2026-11-11.pdf']);
 assert.ok(window.calls.written.includes(JSON.stringify(META).slice(1,-1)),'HTML escrito na janela deve conter a CSP.');
 assert.equal(window.isDestroyed(),true);
}));

for(const [name,render] of Object.entries(templates)){
 test(`modelo ${name}: CSP inserida no início do <head> sem alterar o restante`,()=>{
  const html=render();const secured=withPrintCsp(html);
  assert.match(secured,new RegExp(`<head[^>]*>${META.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`,'i'));
  assert.equal(secured.replace(META,''),html);
  // A CSP só é segura se os modelos não dependerem de nada além de <style> inline.
  assert.doesNotMatch(html,/<script|<link|<iframe|<object|<embed|<base|@import|@font-face|url\(|src=["']?(?!data:)/i);
 });
}

test('CSP de impressão bloqueia scripts e rede',()=>{
 assert.match(PRINT_CSP,/default-src 'none'/);
 assert.doesNotMatch(PRINT_CSP,/script-src|connect-src|https?:|\*/);
 assert.ok(withPrintCsp('<p>x</p>').includes(META));
});

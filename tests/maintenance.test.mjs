import { historyTestScope } from './helpers/history-store.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { MaintenanceService } from '../src/main/maintenance.ts';

const fsPromises=createRequire(import.meta.url)('node:fs/promises');
const protector={isAvailable:async()=>true,encrypt:async text=>Buffer.from(text),decrypt:async data=>({result:data.toString(),shouldReEncrypt:false})};
async function fixture(callback){
 const root=await mkdtemp(join(tmpdir(),'deskdata-cleanup-'));
 const scope=historyTestScope();
 try{
  const history=scope.open(join(root,'state'),protector);
  const docs=join(root,'documents');await mkdir(docs);
  const record=await history.begin('user@example.com','52998224725');
  await history.setCode(record.id,'Q-ABC123DEF4');
  const pdf=join(docs,'RELATORIO_52998224725_2026-10-30.pdf');
  const external=join(docs,'fatura.pdf');
  await writeFile(pdf,'generated');await writeFile(external,'private');
  await history.addPdf(record.id,pdf);
  await callback({root,docs,history,record,pdf,external,maintenance:new MaintenanceService(history)});
 }finally{await scope.closeAll();await rm(root,{recursive:true,force:true});}
}

test('remove exclusivamente PDFs indexados e mantém histórico e códigos para recuperação',async()=>fixture(async({history,record,pdf,external,maintenance})=>{
 const preview=await maintenance.preview();assert.equal(preview.pdfCount,1);assert.equal(preview.recordCount,1);
 const result=await maintenance.clean({pdfs:true,history:false});
 assert.equal(result.deletedPdfs,1);assert.equal(result.deletedRecords,0);
 await assert.rejects(readFile(pdf),{code:'ENOENT'});
 assert.equal(await readFile(external,'utf8'),'private');
 const entry=await history.findById('user@example.com',record.id);
 assert.equal(entry.queryCode,'Q-ABC123DEF4');assert.deepEqual(entry.pdfPaths,[]);
 assert.equal(entry.status,'paused');
}));

test('remoção de histórico apaga metadados sem tocar PDFs ou credenciais',async()=>fixture(async({root,history,pdf,maintenance})=>{
 const credentials=join(root,'state','credentials.bin');await writeFile(credentials,'encrypted');
 const result=await maintenance.clean({pdfs:false,history:true});
 assert.equal(result.deletedRecords,1);
 assert.deepEqual(await history.list('user@example.com'),[]);
 assert.equal(await readFile(pdf,'utf8'),'generated');
 assert.equal(await readFile(credentials,'utf8'),'encrypted');
}));

test('limpeza completa abrange todas as contas e tipos, mas só arquivos registrados',async()=>fixture(async({docs,history,external,maintenance})=>{
 const company=await history.beginCompany('other@example.org','11222333000181');
 const second=join(docs,'CNPJ_11222333000181_2026-10-30.pdf');await writeFile(second,'generated company');
 await history.addPdf(company.id,second);
 const result=await maintenance.clean({pdfs:true,history:true});
 assert.equal(result.deletedPdfs,2);assert.equal(result.deletedRecords,2);
 assert.equal((await maintenance.preview()).recordCount,0);
 assert.equal(await readFile(external,'utf8'),'private');
}));

test('limpeza remove PDFs nos padrões novos (CPI e código da consulta) junto com os legados',async()=>fixture(async({docs,history,record,pdf,maintenance})=>{
 const names=['CPI_537987_275064_2026-11-12.pdf','RELATORIO_Q-ABC123DEF4_2026-11-12-02.pdf','PIS_SEM-CODIGO_2026-11-12.pdf'];
 for(const name of names){const file=join(docs,name);await writeFile(file,'generated');await history.addPdf(record.id,file);}
 const result=await maintenance.clean({pdfs:true,history:false});
 assert.equal(result.deletedPdfs,4);
 for(const file of [pdf,...names.map(name=>join(docs,name))])await assert.rejects(readFile(file),{code:'ENOENT'});
}));

test('impede remoção de PDFs com nomes não reconhecidos e preserva histórico',async()=>fixture(async({docs,history,record,maintenance})=>{
 const unexpected=join(docs,'documento-terceiro.pdf');await writeFile(unexpected,'third party');
 await history.addPdf(record.id,unexpected);
 await assert.rejects(maintenance.clean({pdfs:true,history:true}),/não reconhecido/i);
 assert.equal(await readFile(unexpected,'utf8'),'third party');
 assert.equal((await maintenance.preview()).recordCount,1);
}));

test('falha em arquivo inexistente remove a referência sem enviar requisição à API',async()=>fixture(async({history,record,pdf,maintenance})=>{
 await rm(pdf);
 const result=await maintenance.clean({pdfs:true,history:false});
 assert.equal(result.deletedPdfs,0);assert.equal(result.missingPdfs,1);
 assert.deepEqual((await history.findById('user@example.com',record.id)).pdfPaths,[]);
}));

test('falha parcial informa a contagem sem expor caminho nem CPF do PDF',async()=>fixture(async({docs,history,record,maintenance})=>{
 const second=join(docs,'RELATORIO_11144477735_2026-10-30.pdf');await writeFile(second,'generated');
 const other=await history.begin('user@example.com','11144477735');await history.addPdf(other.id,second);
 const original=fsPromises.unlink;let calls=0;
 // O segundo unlink falha com erro de fs cujo texto contém o caminho (e o CPF) do PDF.
 fsPromises.unlink=async file=>{if(++calls===2)throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${file}'`),{code:'EPERM',path:file});return original(file);};
 syncBuiltinESMExports();
 try{
  const error=await maintenance.clean({pdfs:true,history:false}).then(()=>null,caught=>caught);
  assert.ok(error,'a limpeza deveria falhar.');
  assert.match(error.message,/^Limpeza parcial\. 1 PDF\(s\) excluído\(s\)/);
  assert.doesNotMatch(error.message,/52998224725|11144477735|RELATORIO|EPERM|[\\/]/);
  assert.equal(error.cause,undefined);
  const remaining=[...(await history.findById('user@example.com',record.id)).pdfPaths,...(await history.findById('user@example.com',other.id)).pdfPaths];
  assert.equal(remaining.length,1);
 }finally{fsPromises.unlink=original;syncBuiltinESMExports();}
}));

test('valida seleção e não inicia limpeza sem opções',async()=>fixture(async({maintenance})=>{
 await assert.rejects(maintenance.clean({pdfs:false,history:false}),/selecione/i);
}));

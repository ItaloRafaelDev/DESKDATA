import { historyTestScope } from './helpers/history-store.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MaintenanceService } from '../src/main/maintenance.ts';

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

test('valida seleção e não inicia limpeza sem opções',async()=>fixture(async({maintenance})=>{
 await assert.rejects(maintenance.clean({pdfs:false,history:false}),/selecione/i);
}));

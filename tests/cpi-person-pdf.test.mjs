import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCpiPersonPdf } from '../src/main/cpi/person-pdf.ts';

const cpf='52998224725';
const pdfData=Buffer.concat([Buffer.from('%PDF-1.7\n'),Buffer.alloc(256,65)]);
function record(paths,overrides={}){return {id:'123',kind:'person',account:'a@example.com',cpf,requestedAt:'2026-11-04',updatedAt:'2026-11-04',status:'ready',pdfPaths:paths,...overrides};}
async function withTemp(callback){const root=await mkdtemp(join(tmpdir(),'deskdata-cpi-pdf-'));try{await callback(root);}finally{await rm(root,{force:true,recursive:true});}}
test('CPI: PDF registrado, com nome/CPF correspondente e assinatura válida',()=>withTemp(async root=>{
 const path=join(root,`RELATORIO_${cpf}_2026-11-04.pdf`);await writeFile(path,pdfData);
 assert.equal(await findCpiPersonPdf(record([path]),cpf,root),path);
}));
test('CPI: não procura nem envia PDF de outro CPF',()=>withTemp(async root=>{
 const path=join(root,'RELATORIO_11144477735_2026-11-04.pdf');await writeFile(path,pdfData);
 await assert.rejects(findCpiPersonPdf(record([path]),cpf,root),/PDF correspondente/);
}));
test('CPI: arquivo incorreto ou ausente não é enviado',()=>withTemp(async root=>{
 const path=join(root,`RELATORIO_${cpf}_2026-11-04.pdf`);await writeFile(path,Buffer.alloc(256,66));
 await assert.rejects(findCpiPersonPdf(record([path]),cpf,root),/PDF correspondente/);
}));
test('CPI: consulta pendente ou CPF diferente bloqueia anexo',()=>withTemp(async root=>{
 const path=join(root,`RELATORIO_${cpf}_2026-11-04.pdf`);await writeFile(path,pdfData);
 await assert.rejects(findCpiPersonPdf(record([path],{status:'pending'}),cpf,root),/não está pronta/);
 await assert.rejects(findCpiPersonPdf(record([path],{cpf:'11144477735'}),cpf,root),/não está pronta/);
}));
test('CPI: rejeita documentos fora da pasta configurada, inclusive via link de diretório',()=>withTemp(async root=>{
 const inFolder=join(root,'out');await mkdir(inFolder);
 const outsideFolder=join(root,'outside');await mkdir(outsideFolder);
 const outside=join(outsideFolder,`RELATORIO_${cpf}_2026-11-04.pdf`);await writeFile(outside,pdfData);
 await assert.rejects(findCpiPersonPdf(record([outside]),cpf,inFolder),/PDF correspondente/);
 const link=join(inFolder,'linked');await symlink(outsideFolder,link,process.platform==='win32'?'junction':'dir');
 const linked=join(link,`RELATORIO_${cpf}_2026-11-04.pdf`);
 await assert.rejects(findCpiPersonPdf(record([linked]),cpf,inFolder),/PDF correspondente/);
}));

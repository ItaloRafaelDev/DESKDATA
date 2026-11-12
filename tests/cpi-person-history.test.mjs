import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectCpiPersonHistory} from '../src/main/cpi/person-history.ts';

const cpf='52998224725';
const acct='operador@example.com';
const base={account:acct,cpf,pesquisaId:'537987',solicitacaoId:'275064'};
const record=(path,overrides={})=>({id:'00000000-0000-4000-8000-000000000001',kind:'person',cpf,account:acct,requestedAt:'2026-11-10T09:00:00.000Z',updatedAt:'2026-11-10T09:00:00.000Z',status:'ready',pdfPaths:path?[path]:[],...overrides});
const probe=(args,rec)=>inspectCpiPersonHistory({...base,outputFolder:null,...args,findLatest:async(account,queryCpf,kind)=>{
  assert.equal(account,acct);assert.equal(queryCpf,cpf);assert.equal(kind,'person');return rec;
}});

 test('CPI 4A: sem consulta no histórico da conta, não chama API externa',async()=>{
  assert.deepEqual(await probe({},null),{pesquisaId:'537987',solicitacaoId:'275064',state:'no_history'});
 });
 test('CPI 4A: consulta pendente não é reutilizada como PDF pronto',async()=>{
  assert.equal((await probe({},record(null,{status:'pending'}))).state,'not_ready');
 });
 test('CPI 4A: pasta de PDF ausente é identificada explicitamente',async()=>{
  assert.equal((await probe({},record(null))).state,'folder_unconfigured');
 });
 test('CPI 4A: PDF ausente na pasta configurada não é aceito',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cpi4a-'));
  try {assert.equal((await probe({outputFolder:root},record(join(root,`RELATORIO_${cpf}_2026-11-10.pdf`)))).state,'pdf_unavailable');}
  finally{await rm(root,{recursive:true,force:true});}
 });
 test('CPI 4A: PDF correto é aceito, mas não expõe CPF, caminho nem dados do documento',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cpi4a-'));
  try{
    const path=join(root,`RELATORIO_${cpf}_2026-11-10.pdf`);
    await writeFile(path,Buffer.concat([Buffer.from('%PDF-1.7\n'),Buffer.alloc(120,65)]));
    const result=await probe({outputFolder:root},record(path));
    assert.equal(result.state,'pdf_available');
    const serialized=JSON.stringify(result);
    assert.equal(serialized.includes(cpf),false);
    assert.equal(serialized.includes(root),false);
  }finally{await rm(root,{recursive:true,force:true});}
 });
 test('CPI 4A: rejeita histórico de outra conta ou CPF inconsistente',async()=>{
  await assert.rejects(probe({},record(null,{account:'outro@example.com'})),/inconsistente/);
  await assert.rejects(probe({},record(null,{cpf:'11144477735'})),/inconsistente/);
 });
 test('CPI 4A: rejeita identificadores inválidos antes de ler histórico',async()=>{
  let read=false;
  await assert.rejects(inspectCpiPersonHistory({...base,pesquisaId:'ERRADO',outputFolder:null,findLatest:async()=>{read=true;return null;}}),/Identificadores/);
  assert.equal(read,false);
 });
 test('CPI 4A: consulta mais recente sem PDF pronto não usa documento mais antigo',async()=>{
  assert.equal((await probe({outputFolder:'/tmp'},record(null,{status:'paused'}))).state,'not_ready');
 });

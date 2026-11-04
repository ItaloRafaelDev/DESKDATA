import test from 'node:test'; import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {DiagnosticLogger} from '../src/main/diagnostics.ts';
test('logs estruturados não persistem CPFs, emails, JWTs e senhas',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'deskdata-logs-'));
 try{
  const logger=new DiagnosticLogger(dir);
  await logger.write('ipc_error',{channel:'api:query',error:'CPF 529.982.247-25 senha=segredo email pessoa@teste.com Bearer abc.def.ghi'});
  const files=await readdir(dir); const contents=await readFile(join(dir,files[0]),'utf8');
  assert.match(contents,/ipc_error/);assert.doesNotMatch(contents,/529\.982|pessoa@teste|segredo|abc\.def\.ghi/);
 }finally{await rm(dir,{recursive:true,force:true})}
});

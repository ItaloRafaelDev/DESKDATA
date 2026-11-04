import { historyTestScope } from './helpers/history-store.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { QueryHistoryStore } from '../src/main/query-history.ts';
const protector={isAvailable:async()=>true,encrypt:async text=>Buffer.from(`cipher:${Buffer.from(text).toString('base64')}`),decrypt:async data=>({result:Buffer.from(data.toString().slice(7),'base64').toString(),shouldReEncrypt:false})};
test('índice protege CPF, código e caminho e sobrevive à reinicialização',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'deskdata-history-'));
 const scope=historyTestScope();
 try{
  const store=scope.open(directory,protector);
  const created=await store.begin('a@example.com','52998224725');
  await store.setCode(created.id,'Q-ABC123DEF4');
  await store.addPdf(created.id,'I:\\out\\relatorio.pdf');
  const disk=(await readFile(join(directory,'queries.sqlite'))).toString('latin1');
  assert.doesNotMatch(disk,/52998224725|Q-ABC123DEF4|I:\\out/);
  const another=scope.open(directory,protector);
  const items=await another.list('a@example.com');
  assert.equal(items.length,1);assert.equal(items[0].queryCode,'Q-ABC123DEF4');
  assert.deepEqual(items[0].pdfPaths,['I:\\out\\relatorio.pdf']);
  assert.deepEqual(await another.list('b@example.com'),[]);
 }finally{await scope.closeAll();await rm(directory,{recursive:true,force:true});}
});
test('consulta iniciada sem código permanece como incerta para bloquear POST duplicado',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'deskdata-history-'));
 const scope=historyTestScope();
 try{
  const store=scope.open(directory,protector);
  const created=await store.begin('a@example.com','52998224725');
  const found=await store.findLatest('a@example.com','52998224725');
  assert.equal(found.id,created.id);assert.equal(found.status,'uncertain');
 }finally{await scope.closeAll();await rm(directory,{recursive:true,force:true});}
});

import { historyTestScope } from './helpers/history-store.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {QueryHistoryStore} from '../src/main/query-history.ts';
const protector={isAvailable:async()=>true,encrypt:async text=>Buffer.from(`cipher:${Buffer.from(text).toString('base64')}`),decrypt:async data=>({result:Buffer.from(data.toString().slice(7),'base64').toString(),shouldReEncrypt:false})};
test('SQLite persiste registros individualmente cifrados, sem limite de 1.000, com índices',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'deskdata-sqlite-'));
 const scope=historyTestScope();
 try {
  const history=scope.open(folder,protector);
  for(let i=0;i<1002;i++)await history.begin('test@examplo.com',String(i).padStart(11,'0'));
  const data=await readFile(join(folder,'queries.sqlite'));
  assert.ok(data.toString('utf8',0,15).startsWith('SQLite format 3'));
  assert.doesNotMatch(data.toString('latin1'),/test@examplo\.com|00000000000/);
  assert.equal((await history.list('test@examplo.com')).length,1002);
  assert.deepEqual(await history.list('outra@examplo.com'),[]);
  const snap=await history.backupSnapshot();
  assert.ok(snap.length>100);
 }finally{await scope.closeAll();await rm(folder,{force:true,recursive:true})}
});
test('migracao legacy queries.bin é idempotente, não apaga arquivo e não ressuscita históricos excluídos',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'deskdata-migrate-'));
 const scope=historyTestScope();
 try{
  const original=[{id:'c3f026c0-3c92-4bb5-9a51-7c24b1a51758',kind:'company',account:'test@exemplo.com',cpf:'',cnpj:'00000000000000',requestedAt:'2026-11-04T00:00:00Z',updatedAt:'2026-11-04T00:00:00Z',queryCode:'Q-ABC123DEF4',status:'pending',pdfPaths:[]}];
  await writeFile(join(folder,'queries.bin'),await protector.encrypt(JSON.stringify(original)));
  const store=scope.open(folder,protector);
  assert.equal((await store.list('test@exemplo.com')).length,1);
  assert.ok((await readdir(folder)).includes('queries.bin'));
  await store.clearAll();
  const reopened=scope.open(folder,protector);
  assert.deepEqual(await reopened.list('test@exemplo.com'),[]);
 }finally{await scope.closeAll();await rm(folder,{force:true,recursive:true})}
});
test('chave cifrada ausente em banco existente bloqueia operação em vez de gerar outra',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'deskdata-key-'));
 const scope=historyTestScope();
 try{
  const store=scope.open(folder,protector);
  await store.begin('a@b.com','52998224725');
  await store.close();
  const {unlink}=await import('node:fs/promises');
  await unlink(join(folder,'history-key.bin'));
  const second=scope.open(folder,protector);
  await assert.rejects(()=>second.list('a@b.com'),/Chave cifrada do SQLite ausente/);
 }finally{await scope.closeAll();await rm(folder,{recursive:true,force:true})}
});
test('banco desaparecido depois da inicialização bloqueia consultas novas',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'deskdata-lost-'));
 const scope=historyTestScope();
 try{
  const store=scope.open(folder,protector);
  await store.begin('a@b.com','52998224725');
  await store.close();
  const {unlink}=await import('node:fs/promises');await unlink(join(folder,'queries.sqlite'));
  const reopened=scope.open(folder,protector);
  await assert.rejects(()=>reopened.begin('a@b.com','52998224725'),/Banco de consultas ausente/);
 }finally{await scope.closeAll();await rm(folder,{recursive:true,force:true})}
});

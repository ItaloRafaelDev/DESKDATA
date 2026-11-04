import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialStore } from '../src/main/credentials.ts';

const fakeProtector = {
 isAvailable: async()=>true,
 encrypt: async(text)=>Buffer.from(`protected-${Buffer.from(text).toString('base64')}`),
 decrypt: async(encrypted)=>({result:Buffer.from(encrypted.toString().slice('protected-'.length),'base64').toString(),shouldReEncrypt:false})
};
test('credencial só é persistida cifrada e pode ser recuperada e apagada',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dd-test-'));
 try {
  const store=new CredentialStore(dir,fakeProtector);
  assert.equal((await store.status()).hasSaved,false);
  await store.save('teste@example.org','senha-ficticia');
  assert.equal((await store.status()).hasSaved,true);
  const disk=await readFile(join(dir,'credentials.bin'),'utf8');
  assert.doesNotMatch(disk,/senha-ficticia|teste@example.org/);
  assert.deepEqual(await store.load(),{email:'teste@example.org',password:'senha-ficticia'});
  await store.clear();
  assert.equal((await store.status()).hasSaved,false);
 } finally {await rm(dir,{recursive:true,force:true});}
});
test('não salva senha se criptografia não está disponível',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dd-test-'));
 try {
  const store=new CredentialStore(dir,{...fakeProtector,isAvailable:async()=>false});
  await assert.rejects(store.save('a@b.com','segredo'),/proteção.*indisponível/i);
  assert.equal((await store.status()).hasSaved,false);
 } finally {await rm(dir,{recursive:true,force:true});}
});
test('credencial corrompida é rejeitada sem retornar valores parciais',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dd-test-'));
 try {
  await writeFile(join(dir,'credentials.bin'),'quebrado');
  const store=new CredentialStore(dir,fakeProtector);
  await assert.rejects(store.load(),/credenciais salvas/i);
 } finally {await rm(dir,{recursive:true,force:true});}
});

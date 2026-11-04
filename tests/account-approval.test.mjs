import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountApprovalStore } from '../src/main/account-approval.ts';

const protector = {
  isAvailable: async () => true,
  encrypt: async text => Buffer.from(`encrypted:${Buffer.from(text).toString('base64')}`),
  decrypt: async buf => ({result:Buffer.from(buf.toString().slice(10),'base64').toString(),shouldReEncrypt:false})
};

const withStore = async fn => {
  const folder = await mkdtemp(join(tmpdir(),'deskdata-approval-'));
  try {await fn(folder);} finally {await rm(folder,{recursive:true,force:true});}
};

test('autorização inicia revogada por conta, inclusive quando o legado global era verdadeiro',async()=>withStore(async folder=>{
  const store = new AccountApprovalStore(folder,protector);
  assert.equal(await store.isApproved('a@empresa.com'),false);
  assert.equal(await store.isApproved('b@empresa.com'),false);
}));

test('aprovação não vaza entre contas, inclusive com variação de maiúsculas',async()=>withStore(async folder=>{
  const store = new AccountApprovalStore(folder,protector);
  await store.setApproved('A@EMPRESA.COM',true);
  assert.equal(await store.isApproved('a@empresa.com'),true);
  assert.equal(await store.isApproved('b@empresa.com'),false);
  await store.setApproved('a@empresa.com',false);
  assert.equal(await store.isApproved('a@empresa.com'),false);
}));

test('permissão persiste cifrada e não divulga conta em disco',async()=>withStore(async folder=>{
  const one = new AccountApprovalStore(folder,protector);
  await one.setApproved('a@empresa.com',true);
  assert.equal(await new AccountApprovalStore(folder,protector).isApproved('a@empresa.com'),true);
  assert.doesNotMatch((await readFile(join(folder,'credit-approvals.bin'))).toString(),/a@empresa.com/);
}));

test('mutações simultâneas mantêm permissões distintas',async()=>withStore(async folder=>{
  const store = new AccountApprovalStore(folder,protector);
  await Promise.all(Array.from({length:12},(_,i)=>store.setApproved(`conta${i}@empresa.com`,true)));
  for(let i=0;i<12;i++) assert.equal(await store.isApproved(`conta${i}@empresa.com`),true);
}));

test('falha no índice cifrado bloqueia aprovação, sem conceder acesso por padrão',async()=>withStore(async folder=>{
  const store = new AccountApprovalStore(folder,protector);
  await store.setApproved('a@empresa.com',true);
  const {writeFile} = await import('node:fs/promises');
  await writeFile(join(folder,'credit-approvals.bin'),'invalid');
  await assert.rejects(()=>store.isApproved('a@empresa.com'),/corrompid|indisponível/i);
}));

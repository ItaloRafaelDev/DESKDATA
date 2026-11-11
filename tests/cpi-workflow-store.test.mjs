import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CpiWorkflowStore } from '../src/main/cpi/workflow-store.ts';
const protector={isAvailable:async()=>true,encrypt:async text=>Buffer.from(text),decrypt:async buf=>({result:buf.toString()})};
const ids={pesquisaId:'573987',solicitacaoId:'275064'};
test('fila protegida preserva estado e isola contas',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'deskdata-cpi-store-'));
 try{
  const store=new CpiWorkflowStore(dir,protector);
  assert.equal(await store.get('a',ids),null);
  await store.claim('a',ids);
  await store.mark('a',ids,'query_started',{historyRecordId:'123e4567-e89b-12d3-a456-426614174000'});
  const restored=new CpiWorkflowStore(dir,protector);
  assert.equal((await restored.get('a',ids))?.stage,'query_started');
  assert.equal(await restored.get('b',ids),null);
  assert.equal((await restored.claim('a',ids)).stage,'query_started');
  await restored.mark('a',ids,'pdf_ready',{classification:'information'});
  await restored.mark('a',ids,'submit_started');
  await assert.rejects(restored.mark('a',ids,'pdf_ready'),/não será repetido/);
  await restored.mark('a',ids,'verification_required');
  await assert.rejects(restored.mark('a',ids,'completed'),/não será repetido/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('estado de envio permite finalização, mas não segundo envio',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'deskdata-cpi-store-'));
 try{
  const s=new CpiWorkflowStore(dir,protector);await s.claim('b',ids);
  await s.mark('b',ids,'submit_started');await s.mark('b',ids,'completed');
  await assert.rejects(s.mark('b',ids,'submit_started'),/não será repetido/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

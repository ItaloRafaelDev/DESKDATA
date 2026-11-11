import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CpiWorkflowStore } from '../src/main/cpi/workflow-store.ts';
import { CpiFullAutoRunner } from '../src/main/cpi/full-auto-runner.ts';
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

function fixture(count){
 return {version:1,items:Array.from({length:count},(_,i)=>({
  account:i%2?'b':'a',pesquisaId:String(10000+i),solicitacaoId:String(20000+i),
  stage:i%3===0?'completed':i%3===1?'verification_required':'submit_started',
  updatedAt:'2026-01-01T00:00:00.000Z'
 }))};
}
const nextIds={pesquisaId:'90000',solicitacaoId:'90001'};

test('limite de 10.000 preserva deduplicação e estados incertos após reinício',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'deskdata-cpi-store-'));
 try{
  const path=join(dir,'cpi-workflows.bin');
  await writeFile(path,JSON.stringify(fixture(9999)));
  const store=new CpiWorkflowStore(dir,protector);
  assert.equal((await store.list('a')).length,5000);
  await store.claim('b',nextIds);
  const reloaded=new CpiWorkflowStore(dir,protector);
  assert.equal((await reloaded.list('b')).length,5000);
  assert.equal((await reloaded.claim('b',nextIds)).stage,'claimed');
  await reloaded.mark('b',nextIds,'query_pending');
  assert.equal((await new CpiWorkflowStore(dir,protector).get('b',nextIds)).stage,'query_pending');
  assert.equal((await reloaded.get('a',{pesquisaId:'10000',solicitacaoId:'20000'})).stage,'completed');
  assert.equal((await reloaded.get('b',{pesquisaId:'10001',solicitacaoId:'20001'})).stage,'verification_required');
  assert.equal((await reloaded.get('a',{pesquisaId:'10002',solicitacaoId:'20002'})).stage,'submit_started');
  await assert.rejects(reloaded.claim('a',{pesquisaId:'90002',solicitacaoId:'90003'}),/limite operacional/);
  const afterFailure=new CpiWorkflowStore(dir,protector);
  assert.equal((await afterFailure.list('a')).length,5000);
  assert.equal((await afterFailure.list('b')).length,5000);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('falha simulada durante gravação preserva versão anterior e permite recuperação',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'deskdata-cpi-store-'));
 try{
  const path=join(dir,'cpi-workflows.bin');
  await writeFile(path,JSON.stringify(fixture(1)));
  const before=await readFile(path);
  const interrupted={...protector,encrypt:async text=>{
   await writeFile(join(dir,'cpi-workflows-interrupted.tmp'),text.slice(0,10));
   throw new Error('interrupção simulada');
  }};
  await assert.rejects(new CpiWorkflowStore(dir,interrupted).claim('a',nextIds),/interrupção simulada/);
  assert.deepEqual(await readFile(path),before);
  const recovered=new CpiWorkflowStore(dir,protector);
  assert.equal((await recovered.list('a')).length,1);
  await recovered.claim('a',nextIds);
  assert.equal((await new CpiWorkflowStore(dir,protector).list('a')).length,2);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('FULL AUTO pausa ao atingir limite sem iniciar nova pesquisa nem reenviar',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'deskdata-cpi-store-'));
 try{
  const path=join(dir,'cpi-workflows.bin');
  await writeFile(path,JSON.stringify(fixture(10000)));
  const store=new CpiWorkflowStore(dir,protector);
  let attempts=0;
  const runner=new CpiFullAutoRunner(async()=>{
   attempts++;
   await store.claim('a',nextIds);
   throw new Error('não deveria iniciar consulta');
  });
  await runner.start(30);
  for(let i=0;i<20&&runner.status().phase!=='error';i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(runner.status().phase,'error');
  assert.equal(attempts,1);
  assert.match(runner.status().lastMessage,/limite operacional/);
  assert.equal((await new CpiWorkflowStore(dir,protector).list('a')).length,5000);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('10.001º claim concorrente não altera arquivo nem perde histórico anterior',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'deskdata-cpi-store-'));
 try{
  const path=join(dir,'cpi-workflows.bin');
  await writeFile(path,JSON.stringify(fixture(10000)));
  const before=await readFile(path);
  const store=new CpiWorkflowStore(dir,protector);
  const results=await Promise.allSettled([
   store.claim('a',nextIds),store.claim('b',{pesquisaId:'90002',solicitacaoId:'90003'})
  ]);
  assert.deepEqual(results.map(result=>result.status),['rejected','rejected']);
  assert.match(results[0].reason.message,/limite operacional/);
  assert.deepEqual(await readFile(path),before);
  const reloaded=new CpiWorkflowStore(dir,protector);
  assert.equal((await reloaded.list('a')).length,5000);
  assert.equal((await reloaded.list('b')).length,5000);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('arquivo legado acima do limite é identificado sem ser tratado como corrupção',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'deskdata-cpi-store-'));
 try{
  const path=join(dir,'cpi-workflows.bin');
  await writeFile(path,JSON.stringify(fixture(10001)));
  const before=await readFile(path);
  await assert.rejects(new CpiWorkflowStore(dir,protector).list('a'),/limite operacional/);
  assert.deepEqual(await readFile(path),before);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('arquivo parcial é corrupção; temporário órfão não substitui workflow válido',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'deskdata-cpi-store-'));
 try{
  const path=join(dir,'cpi-workflows.bin');
  await writeFile(path,JSON.stringify(fixture(1)));
  await writeFile(join(dir,'cpi-workflows-interrupted.tmp'),'{"version":1,"items":[');
  assert.equal((await new CpiWorkflowStore(dir,protector).list('a')).length,1);
  await writeFile(path,'{"version":1,"items":[');
  await assert.rejects(new CpiWorkflowStore(dir,protector).list('a'),/corrompida/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CpiWorkflowStore } from '../src/main/cpi/workflow-store.ts';
import { withMainProcess } from './helpers/main-process.mjs';

const protector={isAvailable:async()=>true,encrypt:async value=>Buffer.from(value),decrypt:async value=>({result:value.toString()})};
const ids={pesquisaId:'537987',solicitacaoId:'275064'};
const otherIds={pesquisaId:'537988',solicitacaoId:'275065'};
const account='ipc-tests@example.invalid';

test('query_started aparece na página da conta e no contador, sem habilitar verificação',()=>{
  let remoteChecks=0;
  return withMainProcess(async()=>{throw new Error('POST não permitido');},async({invoke,root})=>{
    const store=new CpiWorkflowStore(root,protector);
    await store.claim(account,ids);
    await store.mark(account,ids,'query_started');
    await store.claim('other@example.invalid',otherIds);
    await store.mark('other@example.invalid',otherIds,'query_started');
    const first=await invoke('cpi:workflow:pending',0,1);
    assert.equal(first.total,1);
    assert.equal(first.items[0].stage,'query_started');
    assert.deepEqual({pesquisaId:first.items[0].pesquisaId,solicitacaoId:first.items[0].solicitacaoId},ids);
    assert.equal((await invoke('cpi:workflow:pending',1,1)).items.length,0);
    assert.equal((await invoke('cpi:history:list')).reviewCount,1);
    await assert.rejects(invoke('cpi:workflow:verify',ids),/não está pendente/);
    assert.equal(remoteChecks,0);
    assert.equal((await new CpiWorkflowStore(root,protector).get(account,ids)).stage,'query_started');
  },{cpiOpen:true,inspectPersisted:async()=>{remoteChecks++;return 'confirmed';}});
});

test('fila version:1 antiga continua legível com query_started sem campos adicionais',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'deskdata-cpi-v1-'));
  try{
    const item={...ids,account,stage:'query_started',updatedAt:'2026-11-12T00:00:00.000Z'};
    await writeFile(join(dir,'cpi-workflows.bin'),JSON.stringify({version:1,items:[item]}));
    const page=await new CpiWorkflowStore(dir,protector).listPending(account,0,10);
    assert.equal(page.total,1);
    assert.equal(page.items[0].stage,'query_started');
  }finally{await rm(dir,{recursive:true,force:true});}
});

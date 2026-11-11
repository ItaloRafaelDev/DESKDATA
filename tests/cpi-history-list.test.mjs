import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CpiWorkflowStore } from '../src/main/cpi/workflow-store.ts';
const protector={
  isAvailable:async()=>true,
  encrypt:async value=>Buffer.from('enc:'+Buffer.from(value).toString('base64')),
  decrypt:async value=>({result:Buffer.from(value.toString().slice(4),'base64').toString(),shouldReEncrypt:false})
};
test('histórico CPI é persistente e isolado por conta', async()=>{
  const folder=await mkdtemp(join(tmpdir(),'deskdata-cpi-hist-'));
  try{
    const store=new CpiWorkflowStore(folder,protector);
    const first={pesquisaId:'538823',solicitacaoId:'275528'};
    const second={pesquisaId:'538827',solicitacaoId:'275529'};
    await store.claim('a',first);
    await store.mark('a',first,'completed',{classification:'restrictions'});
    await store.claim('b',second);
    const reloaded=new CpiWorkflowStore(folder,protector);
    const list=await reloaded.list('A');
    assert.equal(list.length,1);
    assert.deepEqual([list[0].pesquisaId,list[0].classification,list[0].stage],['538823','restrictions','completed']);
    assert.equal((await reloaded.list('b')).length,1);
    assert.equal((await reloaded.list('c')).length,0);
    list[0].stage='review_required';
    assert.equal((await reloaded.list('a'))[0].stage,'completed');
  }finally{await rm(folder,{recursive:true,force:true});}
});

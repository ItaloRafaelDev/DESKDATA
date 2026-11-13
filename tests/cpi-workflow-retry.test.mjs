import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CpiWorkflowStore } from '../src/main/cpi/workflow-store.ts';

const ids={pesquisaId:'537987',solicitacaoId:'275064'};
const protector={isAvailable:async()=>true,encrypt:async text=>Buffer.from(text),
  decrypt:async bytes=>({result:bytes.toString(),shouldReEncrypt:false})};

test('prova local de ausência de envio é a única transição que devolve submit_started para pdf_ready',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'deskdata-cpi-no-submit-'));
  try{
    const store=new CpiWorkflowStore(directory,protector);
    await store.claim('retry@example.invalid',ids);
    await store.mark('retry@example.invalid',ids,'pdf_ready',{
      historyRecordId:'123e4567-e89b-12d3-a456-426614174000',classification:'information'});
    await store.mark('retry@example.invalid',ids,'submit_started');
    assert.equal((await store.recordNotSubmitted('retry@example.invalid',ids)).stage,'pdf_ready');
    await assert.rejects(store.recordNotSubmitted('retry@example.invalid',ids),/envio iniciado/);
    await store.mark('retry@example.invalid',ids,'submit_started');
    await store.mark('retry@example.invalid',ids,'verification_required');
    await assert.rejects(store.recordNotSubmitted('retry@example.invalid',ids),/envio iniciado/);
  }finally{await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { historyTestScope } from './helpers/history-store.mjs';

test('addPdf rejeita identidade incompatível sem alterar status ou referências',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'deskdata-pdf-identity-'));
  const scope=historyTestScope();
  const protector={isAvailable:async()=>true,encrypt:async s=>Buffer.from(s),decrypt:async b=>({result:b.toString(),shouldReEncrypt:false})};
  try{
    const history=scope.open(dir,protector);
    const row=await history.begin('test@example.invalid','11144477735');
    const before=await history.findById('test@example.invalid',row.id);
    await assert.rejects(history.addPdf(row.id,join(dir,'wrong-person.pdf'),{
      account:'test@example.invalid',kind:'person',document:'52998224725'
    }),/histórico|identidade|corresponde/i);
    assert.deepEqual(await history.findById('test@example.invalid',row.id),before);
  }finally{await scope.closeAll();await rm(dir,{recursive:true,force:true});}
});

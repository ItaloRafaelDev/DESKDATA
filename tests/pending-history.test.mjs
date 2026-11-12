import { historyTestScope } from './helpers/history-store.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
const protector={isAvailable:async()=>true,encrypt:async s=>Buffer.from(s),decrypt:async b=>({result:b.toString()})};
test('registro pendente persiste e pausado pode ser retomado sem novo POST',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'deskdata-watch-'));
 const scope=historyTestScope();
 try{const history=scope.open(dir,protector);const record=await history.beginCompany('account@example.org','11222333000181');
  await history.setCode(record.id,'Q-ABC123DEF4');await history.setPaused(record.id,'Recuperação pausada');
  const next=scope.open(dir,protector);assert.equal((await next.findById('account@example.org',record.id)).status,'paused');
  await next.setPending(record.id);const found=await next.findById('account@example.org',record.id);
  assert.equal(found.status,'pending');assert.equal(found.lastIssue,undefined);assert.equal(found.queryCode,'Q-ABC123DEF4');
 }finally{await scope.closeAll();await rm(dir,{recursive:true,force:true});}
});

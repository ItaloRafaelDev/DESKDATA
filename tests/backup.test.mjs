import { historyTestScope } from './helpers/history-store.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {BackupService} from '../src/main/backup.ts';
const protector={isAvailable:async()=>true,encrypt:async text=>Buffer.from(`cipher:${Buffer.from(text).toString('base64')}`),decrypt:async data=>({result:Buffer.from(data.toString().slice(7),'base64').toString(),shouldReEncrypt:false})};
test('backup ZIP armazena apenas históricos e configurações cifradas, nunca credenciais nem PDFs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'deskdata-backup-'));
 const scope=historyTestScope();
 try{
  const history=scope.open(join(root,'user'),protector);
  await history.begin('pessoa@exemplo.com','52998224725');
  const svc=new BackupService({userData:join(root,'user'),backupDirectory:join(root,'backups'),history,protector,getSettings:async()=>({outputFolder:'C:\\relatorios',paidQueriesApproved:false})});
  const result=await svc.create();
  const bytes=await readFile(result.path);
  assert.equal(bytes.toString('ascii',0,2),'PK');
  assert.doesNotMatch(bytes.toString('latin1'),/pessoa@exemplo|52998224725|C:\\relatorios|credentials\.bin/);
  assert.match(bytes.toString('latin1'),/history\.sqlite/);
  assert.match(bytes.toString('latin1'),/history-key\.bin/);
  assert.match(bytes.toString('latin1'),/settings\.bin/);
  assert.equal((await readdir(join(root,'backups'))).length,1);
 }finally{await scope.closeAll();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
});

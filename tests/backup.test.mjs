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

// P7 (E5): compressão fora do laço de eventos e ZIP íntegro (CRC e conteúdo conferidos ao extrair).
import {createZip} from '../src/main/backup.ts';
import {inflateRawSync,crc32 as nativeCrc} from 'node:zlib';
import {randomBytes} from 'node:crypto';
function readEntries(zip){
 const out=[];let at=0;
 while(zip.readUInt32LE(at)===0x04034b50){
  const crc=zip.readUInt32LE(at+14),size=zip.readUInt32LE(at+18),nameLength=zip.readUInt16LE(at+26);
  const name=zip.toString('utf8',at+30,at+30+nameLength);const start=at+30+nameLength;
  out.push({name,crc,data:inflateRawSync(zip.subarray(start,start+size))});at=start+size;
 }
 return out;
}
test('P7: createZip é assíncrono, mantém o laço de eventos livre e gera entradas íntegras',async()=>{
 const big=Buffer.concat([randomBytes(4*1024*1024),Buffer.alloc(28*1024*1024,7)]);
 const small=Buffer.from('{"ok":true}');
 let ticks=0,zip;const timer=setInterval(()=>{ticks++;},1);
 try{
  const pending=createZip([{name:'manifest.json',data:small},{name:'history.sqlite',data:big}]);
  assert.ok(pending instanceof Promise);
  zip=await pending;
 }finally{clearInterval(timer);}
 assert.ok(ticks>0,'a compressão bloqueou o processo principal');
 const entries=readEntries(zip);
 assert.deepEqual(entries.map(e=>e.name),['manifest.json','history.sqlite']);
 assert.ok(entries[0].data.equals(small));assert.ok(entries[1].data.equals(big));
 assert.equal(entries[1].crc,nativeCrc(big));
});
test('P7: createZip rejeita nome inválido e arquivo acima de 100 MB sem comprimir',async()=>{
 await assert.rejects(createZip([{name:'../x',data:Buffer.alloc(1)}]),/Nome de arquivo ZIP inválido/);
 await assert.rejects(createZip([{name:'a.bin',data:{length:100*1024*1024+1}}]),/excede 100 MB/);
});

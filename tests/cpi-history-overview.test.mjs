import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { historyTestScope } from './helpers/history-store.mjs';
import { buildCpiHistoryOverview } from '../src/main/cpi/history-overview.ts';

// P8 (E5): o histórico CPI lê os registros vinculados em lote (um bloqueio do histórico), não um findById por item.
const protector={isAvailable:async()=>true,encrypt:async s=>Buffer.from(s),decrypt:async b=>({result:b.toString(),shouldReEncrypt:false})};
const who='pessoa@exemplo.invalid';

test('P8: findManyById devolve só registros da conta, ignora ids inválidos e usa um único bloqueio',async()=>{
  const root=await mkdtemp(join(tmpdir(),'deskdata-p8-'));const scope=historyTestScope();
  try{
    const store=scope.open(root,protector);
    const mine=await store.begin(who,'52998224725');const other=await store.begin('outra@exemplo.invalid','52998224725');
    let locks=0;const original=store.lock.bind(store);store.lock=fn=>{locks++;return original(fn);};
    const found=await store.findManyById(who,[mine.id,other.id,'nao-e-uuid',mine.id]);
    assert.equal(locks,1);
    assert.deepEqual([...found.keys()],[mine.id]);
    assert.equal(found.get(mine.id).account,who);
    assert.equal((await store.findManyById(who,[])).size,0);
  }finally{await scope.closeAll();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('P8: visão do histórico CPI com 100 concluídas faz uma leitura em lote e confere o PDF de cada uma',async()=>{
  const root=await mkdtemp(join(tmpdir(),'deskdata-p8-'));
  try{
    const pdf=join(root,'CPI_1_1_2026-11-13.pdf');await writeFile(pdf,'%PDF-1.4');
    const ids=Array.from({length:120},(_,i)=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`);
    const items=ids.map((historyRecordId,i)=>({pesquisaId:String(i+1),solicitacaoId:String(i+1),stage:'completed',
      classification:i%2?'restrictions':undefined,updatedAt:'2026-11-13T00:00:00Z',historyRecordId,pdfPaths:[]}));
    items.push({pesquisaId:'900',solicitacaoId:'900',stage:'review_required',updatedAt:'x',pdfPaths:[]});
    const batches=[];
    const history={
      findById:async()=>{throw new Error('não deve ler um registro por vez');},
      findManyById:async(account,wanted)=>{batches.push(wanted.length);assert.equal(account,who);
        return new Map(wanted.map((id,i)=>[id,{id,account:who,kind:'person',pdfPaths:i===0?[pdf]:[join(root,'ausente.pdf')]}]));}
    };
    const overview=await buildCpiHistoryOverview(who,items,history);
    assert.deepEqual(batches,[100]);
    assert.equal(overview.completedCount,120);assert.equal(overview.reviewCount,1);assert.equal(overview.items.length,100);
    assert.equal(overview.items[0].pdfAvailable,true);assert.equal(overview.items[1].pdfAvailable,false);
    assert.equal(overview.items[0].classification,'information');assert.equal(overview.items[1].classification,'restrictions');
    assert.deepEqual(Object.keys(overview.items[0]).sort(),['answeredAt','classification','pdfAvailable','pesquisaId','solicitacaoId']);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('P8: registro de outra conta ou de outro tipo nunca marca PDF disponível',async()=>{
  const items=[{pesquisaId:'1',solicitacaoId:'1',stage:'completed',updatedAt:'x',historyRecordId:'00000000-0000-4000-8000-000000000001',pdfPaths:[]},
    {pesquisaId:'2',solicitacaoId:'2',stage:'completed',updatedAt:'x',historyRecordId:'00000000-0000-4000-8000-000000000002',pdfPaths:[]}];
  const history={findManyById:async()=>new Map([
    ['00000000-0000-4000-8000-000000000001',{account:'outra@exemplo.invalid',kind:'person',pdfPaths:[import.meta.filename]}],
    ['00000000-0000-4000-8000-000000000002',{account:who,kind:'company',pdfPaths:[import.meta.filename]}]])};
  const overview=await buildCpiHistoryOverview(who,items,history,async()=>true);
  assert.deepEqual(overview.items.map(i=>i.pdfAvailable),[false,false]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readResponseLimited} from '../src/main/http-response.ts';

function responseChunks(chunks){
  let cancelled=false;
  let next=0;
  const stream=new ReadableStream({
    pull(controller){if(next<chunks.length)controller.enqueue(chunks[next++]);else controller.close();},
    cancel(){cancelled=true;}
  });
  return {response:{body:stream,headers:new Headers()},get cancelled(){return cancelled;}};
}

test('lê JSON UTF-8 em chunks e preserva acentos e fronteiras de caracteres',async()=>{
  const bytes=new TextEncoder().encode('{"label":"código válido"}');
  const r=responseChunks([bytes.subarray(0,13),bytes.subarray(13,18),bytes.subarray(18)]);
  const text=await readResponseLimited(r.response,1024);
  assert.deepEqual(JSON.parse(text),{label:'código válido'});
});

test('rejeita payload que ultrapassa limite durante recebimento sem montar conteúdo total',async()=>{
  const bytes=new TextEncoder().encode('012345678901234567890');
  const r=responseChunks([bytes.subarray(0,8),bytes.subarray(8)]);
  await assert.rejects(()=>readResponseLimited(r.response,12),/limite.*resposta|resposta.*limite/i);
  assert.equal(r.cancelled,true);
});

test('rejeita Content-Length excessivo sem consumir stream',async()=>{
  let reads=0;
  const r={headers:new Headers({'content-length':'1000'}),body:{getReader(){reads++;throw new Error('never read');}}};
  await assert.rejects(()=>readResponseLimited(r,99),/limite.*resposta|resposta.*limite/i);
  assert.equal(reads,0);
});

test('aceita fakes legados que expõem apenas text() e aplica limite também a eles',async()=>{
  assert.equal(await readResponseLimited({text:async()=>'ok'},10),'ok');
  await assert.rejects(()=>readResponseLimited({text:async()=>"ééé"},5),/limite.*resposta|resposta.*limite/i);
});

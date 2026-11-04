import test from 'node:test';
import assert from 'node:assert/strict';
import { DeskdataClient } from '../src/main/deskdata-client.ts';
const code='Q-ABC123DEF4';
const responses=(status, data={}, extra={})=>new Response(JSON.stringify({status:{code:status===202?4008:4000},data,...extra}),{status});
const auth=()=>new Response(JSON.stringify({status:{code:2000},data:{access_token:'test-token',expires_at:new Date(Date.now()+3600000).toISOString()}}),{status:200});
test('POST 202 de pessoa retorna pending imediatamente sem executar GET',async()=>{
 const calls=[]; const c=new DeskdataClient(async(url,opt)=>{calls.push([url,opt.method]);return url.endsWith('/auth')?auth():responses(202,{}, {query:{code}})},async()=>{throw new Error('Não pode dormir');});
 await c.authenticate('dev@example.org','secret');const received=await c.submitCpf('52998224725');
 assert.deepEqual(received,{state:'pending',queryCode:code});
 assert.equal(calls.filter(([url])=>url.endsWith('/queries')).length,1);
 assert.equal(calls.filter(([url])=>url.includes('/queries/')).length,0);
});
test('GET 202 informa pending e GET 200 retorna payload sem novos POST',async()=>{
 let n=0;const calls=[];const c=new DeskdataClient(async(url,opt)=>{calls.push(opt.method);return url.endsWith('/auth')?auth():n++===0?responses(202):responses(200,{basic:{}},{query_code:code})});
 await c.authenticate('dev@example.org','secret');
 assert.equal((await c.checkByCode(code)).state,'pending');
 const ready=await c.checkByCode(code);assert.equal(ready.state,'ready');assert.equal(ready.queryCode,code);
 assert.equal(calls.filter(method=>method==='POST').length,1);
});
test('POST 202 empresarial usa apenas um POST e recupera código para monitoramento',async()=>{
 let count=0;const c=new DeskdataClient(async(url)=>url.endsWith('/auth')?auth():(count++,responses(202,{}, {query_code:code})));
 await c.authenticate('dev@example.org','secret');const result=await c.submitCompany('11222333000181');
 assert.equal(result.state,'pending');assert.equal(result.queryCode,code);assert.equal(count,1);
});

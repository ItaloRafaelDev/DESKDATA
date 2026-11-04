import test from 'node:test';
import assert from 'node:assert/strict';
import { DeskdataClient } from '../src/main/deskdata-client.ts';
const response=(code, data, status=200, extra={})=>({ok:status>=200&&status<300,status,text:async()=>JSON.stringify({status:{code}, data, ...extra})});
test('autentica por POST /auth e consulta créditos sem expor credenciais nas URLs',async()=>{
  const calls=[];
  const fake=async (url,opts)=>{ calls.push({url,opts}); return calls.length===1?response(2000,{access_token:'fake',expires_at:new Date(Date.now()+3600000).toISOString()}):response(3000,{balance:12});};
  const client=new DeskdataClient(fake);
  await client.authenticate('teste@example.org','segredo');
  assert.equal(await client.credits(),12);
  assert.equal(calls[0].url,'https://api.deskdata.com.br/auth');
  assert.equal(calls[1].opts.headers.Authorization,'Bearer fake');
});
test('uma consulta lógica envia cinco datasets em somente um POST',async()=>{
  const calls=[];
  const fake=async (url,opts)=>{calls.push({url,opts}); if(url.endsWith('/auth'))return response(2000,{access_token:'fake',expires_at:new Date(Date.now()+3600000).toISOString()});return response(4000,{basic:{},phones:{items:[]},addresses:{items:[]},emails:{items:[]},lawsuits:{items:[]}});};
  const client=new DeskdataClient(fake);await client.authenticate('teste@example.org','segredo');
  await client.queryCpf('52998224725');
  const posts=calls.filter(x=>x.url.endsWith('/queries'));
  assert.equal(posts.length,1);
  assert.deepEqual(JSON.parse(posts[0].opts.body).datasets,['basic','phones','addresses','emails','lawsuits']);
});
test('HTTP 202 reutiliza query.code em GET, sem repetir POST de cobrança', async()=>{
  const calls=[];
  const code='Q-ABC123DEF4';
  const fake=async(url,opts)=>{
    calls.push({url,method:opts.method});
    if(url.endsWith('/auth'))return response(2000,{access_token:'fake',expires_at:new Date(Date.now()+3600000).toISOString()});
    if(opts.method==='POST')return response(4008,{},202,{query:{code}});
    return response(4000,{basic:{},phones:{items:[]},addresses:{items:[]},emails:{items:[]},lawsuits:{items:[]}});
  };
  const client=new DeskdataClient(fake,async()=>{});
  await client.authenticate('teste@example.org','segredo');
  const result=await client.queryCpf('52998224725');
  assert.equal(result.queryCode,code);
  assert.equal(calls.filter(x=>x.method==='POST'&&x.url.endsWith('/queries')).length,1);
  assert.equal(calls.filter(x=>x.method==='GET'&&x.url.endsWith(`/queries/${code}`)).length,1);
});
test('extrai o código do sucesso por query_code ou query.code',async()=>{
  for(const extra of [{query_code:'Q-AABBCCDDEE'},{query:{code:'Q-ABC123DEF4'}}]){
    const fake=async(url)=>url.endsWith('/auth')?response(2000,{access_token:'fake',expires_at:new Date(Date.now()+3600000).toISOString()}):response(4000,{basic:{}},200,extra);
    const client=new DeskdataClient(fake);await client.authenticate('a@b.com','senha');
    assert.match((await client.queryCpf('52998224725')).queryCode,/^Q-/);
  }
});
test('GET de código conhecido recupera resultado sem novo POST',async()=>{
 const calls=[];
 const fake=async(url,opts)=>{calls.push([url,opts.method]);return url.endsWith('/auth')?response(2000,{access_token:'fake',expires_at:new Date(Date.now()+3600000).toISOString()}):response(4000,{basic:{},phones:{items:[]},addresses:{items:[]},emails:{items:[]},lawsuits:{items:[]}});};
 const client=new DeskdataClient(fake);await client.authenticate('a@b.com','senha');
 const result=await client.fetchByCode('Q-ABC123DEF4');
 assert.equal(result.queryCode,'Q-ABC123DEF4');
 assert.deepEqual(calls.slice(1),[['https://api.deskdata.com.br/queries/Q-ABC123DEF4','GET']]);
});

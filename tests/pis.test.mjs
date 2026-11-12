import { historyTestScope } from './helpers/history-store.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePisResult, renderPisPdfHtml } from '../src/shared/pis-report.ts';
import { DeskdataClient } from '../src/main/deskdata-client.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const cpf='52998224725';
const payload={ status:{code:4000},data:{basic:{name:{full_name:'Maria de Teste'},gender:'F',birthdate:'1997-11-26T00:00:00Z',age:28,tax_id:{number:cpf,status:'REGULAR',fiscal_region:'SP',registration_date:'2009-12-02T00:00:00Z'},social_security:{number:'14265531608'}}}};
const response=(code,data,status=200,extra={})=>({ok:status>=200&&status<300,status,text:async()=>JSON.stringify({status:{code},data,...extra})});
test('consulta PIS somente basic por POST /queries, não altera a consulta completa',async()=>{
 const calls=[];
 const fetcher=async(url,opts)=>{calls.push({url,opts});return url.endsWith('/auth')?response(2000,{access_token:'fake',expires_at:new Date(Date.now()+3_600_000).toISOString()}):response(4000,payload.data);};
 const api=new DeskdataClient(fetcher);await api.authenticate('teste@example.com','senha');await api.queryBasicCpf(cpf);
 const posts=calls.filter(x=>x.url.endsWith('/queries'));
 assert.equal(posts.length,1);assert.deepEqual(JSON.parse(posts[0].opts.body),{type:'persons',key_type:'cpf',key_value:cpf,datasets:['basic']});
});
test('extrai PIS e nove campos com tradução de datas e gênero, sem inventar dados',()=>{
 const item=normalizePisResult(payload,cpf);
 assert.equal(item.name,'Maria de Teste');assert.equal(item.gender,'Feminino');assert.equal(item.birthdate,'26/11/1997');
 assert.equal(item.pis,'142.65531.60-8');assert.equal(item.registrationDate,'02/12/2009');
 assert.equal(item.cpf,'529.982.247-25');
});
test('falha com PIS ausente ou com CPF divergente, sem fabricar PDF',()=>{
 const copy=structuredClone(payload);delete copy.data.basic.social_security;
 assert.throws(()=>normalizePisResult(copy,cpf),/PIS/);
 const wrong=structuredClone(payload);wrong.data.basic.tax_id.number='12345678909';
 assert.throws(()=>normalizePisResult(wrong,cpf),/CPF/);
});
test('falha quando basic contém erro isolado, mesmo com status HTTP geral bem-sucedido',()=>{
 assert.throws(()=>normalizePisResult({status:{code:4000},data:{basic:{error:'Internal error'}}},cpf),/basic/);
});
test('PDF PIS contém nove campos, não contém marca de fonte e escapa texto arbitrário',()=>{
 const record=normalizePisResult(payload,cpf);const markup=renderPisPdfHtml({...record,name:'<script>alert(1)</script>'});
 assert.doesNotMatch(markup,/<script>alert/);assert.match(markup,/&lt;script&gt;/);
 for(const label of ['Nome','Gênero','Nascimento','Idade','CPF','Situação do CPF','Região fiscal','Data de registro do CPF','PIS'])assert.match(markup,new RegExp(label));
 assert.doesNotMatch(markup,/Deskdata|Fonte:|MODELO 01/i);
});
const protector={isAvailable:async()=>true,encrypt:async text=>Buffer.from('cipher:'+Buffer.from(text).toString('base64')),decrypt:async data=>({result:Buffer.from(data.toString().slice(7),'base64').toString(),shouldReEncrypt:false})};
test('histórico PIS separado do histórico de pessoas e compatível com registros antigos',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'deskdata-pis-'));
 const scope=historyTestScope();
 try{const db=scope.open(dir,protector);await db.begin('user@example.com',cpf);const pis=await db.begin('user@example.com',cpf,'pis');
  assert.equal((await db.list('user@example.com','pis')).length,1);
  assert.equal((await db.findLatest('user@example.com',cpf))?.kind,'person');
  assert.equal((await db.findLatest('user@example.com',cpf,'pis'))?.id,pis.id);
 }finally{await scope.closeAll();await rm(dir,{recursive:true,force:true});}
});

test('PIS ausente é resultado conhecido, sem gerar PDF e com registro persistente', async()=>{
 const { resolvePisOutcome }=await import('../src/main/pis-outcome.ts');
 const dir=await mkdtemp(join(tmpdir(),'deskdata-pis-missing-'));
 const scope=historyTestScope();
 try{
  const db=scope.open(dir,protector);
  const row=await db.begin('user@example.com',cpf,'pis');
  await db.setCode(row.id,'Q-ABC123DEF4');
  const missing=structuredClone(payload);missing.data.basic.social_security={number:null};
  let saves=0;
  const result=await resolvePisOutcome({
   cpf,payload:missing,recordId:row.id,queryCode:'Q-ABC123DEF4',
   save:async()=>{saves++;return {path:'ignored.pdf',savedAt:new Date().toISOString()};},
   markUnavailable:()=>db.markPisUnavailable(row.id)
  });
  assert.equal(result.state,'no_pis');assert.equal(saves,0);
  assert.equal(result.queryCode,'Q-ABC123DEF4');
  const reloaded=scope.open(dir,protector);
  const record=await reloaded.findLatest('user@example.com',cpf,'pis');
  assert.equal(record.status,'pis_unavailable');assert.equal(record.pdfPaths.length,0);
  assert.equal(record.queryCode,'Q-ABC123DEF4');
 }finally{await scope.closeAll();await rm(dir,{recursive:true,force:true});}
});

test('a ausência de PIS não oculta CPF divergente, dataset quebrado ou número inválido',async()=>{
 const {resolvePisOutcome}=await import('../src/main/pis-outcome.ts');
 const run=async data=>resolvePisOutcome({cpf,payload:data,recordId:'test',save:async()=>{throw Error('not expected')},markUnavailable:async()=>{throw Error('not expected')}});
 const wrong=structuredClone(payload);wrong.data.basic.tax_id.number='12345678909';delete wrong.data.basic.social_security;
 await assert.rejects(()=>run(wrong),/CPF retornado/);
 const broken=structuredClone(payload);broken.data.basic={error:'Erro do dataset'};
 await assert.rejects(()=>run(broken),/basic/);
 const invalid=structuredClone(payload);invalid.data.basic.social_security.number='12';
 await assert.rejects(()=>run(invalid),/inválido/);
});

test('PIS que reaparece em GET gera PDF no mesmo histórico',async()=>{
 const {resolvePisOutcome}=await import('../src/main/pis-outcome.ts');
 const dir=await mkdtemp(join(tmpdir(),'deskdata-pis-restored-'));
 const scope=historyTestScope();
 try{
  const db=scope.open(dir,protector);const row=await db.begin('user@example.com',cpf,'pis');
  await db.setCode(row.id,'Q-ABC123DEF4');await db.markPisUnavailable(row.id);
  let saves=0;
  const result=await resolvePisOutcome({cpf,payload,recordId:row.id,queryCode:'Q-ABC123DEF4',save:async record=>{
   saves++;assert.equal(record.pis,'142.65531.60-8');await db.addPdf(row.id,'I:\\pis.pdf');return {path:'I:\\pis.pdf',savedAt:new Date().toISOString()};
  },markUnavailable:async()=>{throw Error('not expected')}});
  assert.equal(result.state,'ready');assert.equal(saves,1);
  const updated=await db.findLatest('user@example.com',cpf,'pis');assert.equal(updated.status,'ready');
 }finally{await scope.closeAll();await rm(dir,{recursive:true,force:true});}
});

test('número do PIS ausente em branco ou objeto previdenciário ausente não gera PDF',async()=>{
 const {resolvePisOutcome}=await import('../src/main/pis-outcome.ts');
 for(const social of [undefined,{number:undefined},{number:''},{number:'   '},{number:null}]){
  const data=structuredClone(payload);
  if(social===undefined)delete data.data.basic.social_security;else data.data.basic.social_security=social;
  const result=await resolvePisOutcome({cpf,payload:data,recordId:'same',save:async()=>{throw Error('não deveria salvar')},markUnavailable:async()=>{}});
  assert.equal(result.state,'no_pis');
 }
});

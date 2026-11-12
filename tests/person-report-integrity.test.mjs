import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { historyTestScope } from './helpers/history-store.mjs';
import { PersonReportService } from '../src/main/person-reports.ts';

const ACCOUNT='person-tests@example.invalid';
const CPF_A='52998224725', CPF_B='11144477735';
const CODE_A='Q-AAAAAAAAAA', CODE_B='Q-BBBBBBBBBB';
const protector={isAvailable:async()=>true,encrypt:async s=>Buffer.from(s),decrypt:async b=>({result:b.toString(),shouldReEncrypt:false})};
function payload(cpf){return {status:{code:4000},data:{basic:{tax_id:{number:cpf}},phones:{items:[]},addresses:{items:[]},emails:{items:[]},lawsuits:{items:[]}}};}

async function fixture(run){
  const dir=await mkdtemp(join(tmpdir(),'deskdata-person-integrity-'));
  const scope=historyTestScope();
  try{
    const history=scope.open(dir,protector);
    let currentAccount=ACCOUNT, renders=0, beforeReturn=async()=>{};
    const reports=new PersonReportService({history,currentAccount:()=>currentAccount,
      getOutputFolder:async()=>dir,
      savePdf:async(_folder,report)=>{
        renders++;
        await beforeReturn();
        return {path:join(dir,`RELATORIO_${report.queryCode??'SEM-CODIGO'}_${renders}.pdf`),savedAt:'2026-11-11T00:00:00Z',queryCode:report.queryCode};
      }});
    const begin=async(cpf,code)=>{const row=await history.begin(ACCOUNT,cpf);if(code)await history.setCode(row.id,code);return row;};
    const received=(row,cpf,code)=>({account:ACCOUNT,recordId:row.id,cpf,queryCode:code,consultedAt:'2026-11-11T00:00:00Z',payload:payload(cpf)});
    await run({history,reports,begin,received,dir,renders:()=>renders,
      setAccount:who=>{currentAccount=who;},beforeSaveReturns:fn=>{beforeReturn=fn;}});
  }finally{await scope.closeAll();await rm(dir,{recursive:true,force:true});}
}

for(const state of ['pending','uncertain']){
  test(`A concluída, B ${state}: reprocessar e salvar novamente preservam o registro de B`,()=>fixture(async f=>{
    const a=await f.begin(CPF_A,CODE_A);
    await f.reports.processReceived(f.received(a,CPF_A,CODE_A));
    const b=await f.begin(CPF_B,state==='pending'?CODE_B:undefined);
    const before=await f.history.findById(ACCOUNT,b.id);
    const regenerated=await f.reports.reprocessLastResponse();
    const savedAgain=await f.reports.saveAgain();
    assert.equal(regenerated.recordId,a.id);
    assert.equal(savedAgain.recordId,a.id);
    assert.deepEqual(await f.history.findById(ACCOUNT,b.id),before);
    assert.equal((await f.history.findById(ACCOUNT,a.id)).pdfPaths.length,3);
    assert.equal(f.reports.readFor(ACCOUNT,CPF_A,b.id),null);
  }));
}

test('resposta imediata divergente não gera PDF, não entra no cache e não marca ready',()=>fixture(async f=>{
  const b=await f.begin(CPF_B,CODE_B);
  const result=f.received(b,CPF_B,CODE_B);result.payload=payload(CPF_A);
  await assert.rejects(f.reports.processReceived(result),/CPF|corresponde/i);
  assert.equal(f.renders(),0);
  assert.deepEqual(f.reports.status(),{hasResponse:false,hasReport:false});
  const stored=await f.history.findById(ACCOUNT,b.id);
  assert.equal(stored.status,'pending');assert.deepEqual(stored.pdfPaths,[]);
}));

test('resposta válida mantém código, PDF e registro original',()=>fixture(async f=>{
  const a=await f.begin(CPF_A,CODE_A);
  const result=await f.reports.processReceived(f.received(a,CPF_A,CODE_A));
  assert.equal(result.recordId,a.id);assert.equal(result.queryCode,CODE_A);
  const stored=await f.history.findById(ACCOUNT,a.id);
  assert.equal(stored.status,'ready');assert.deepEqual(stored.pdfPaths,[result.path]);
}));

test('resposta imediata sem código permanece recuperável no registro original após falha de PDF',()=>fixture(async f=>{
  const a=await f.begin(CPF_A,undefined);
  f.beforeSaveReturns(async()=>{throw new Error('Gerador indisponível');});
  await assert.rejects(f.reports.processReceived(f.received(a,CPF_A,undefined)),/Gerador/);
  const b=await f.begin(CPF_B,CODE_B);
  f.beforeSaveReturns(async()=>{});
  const result=await f.reports.reprocessLastResponse();
  assert.equal(result.recordId,a.id);assert.equal(result.queryCode,undefined);
  assert.equal((await f.history.findById(ACCOUNT,a.id)).status,'ready');
  assert.equal((await f.history.findById(ACCOUNT,b.id)).status,'pending');
}));

test('alterar a resposta fornecida ou uma leitura do cache não troca a identidade armazenada',()=>fixture(async f=>{
  const a=await f.begin(CPF_A,CODE_A),received=f.received(a,CPF_A,CODE_A);
  await f.reports.processReceived(received);
  received.cpf=CPF_B;received.payload.data.basic.tax_id.number=CPF_B;
  const cached=f.reports.readFor(ACCOUNT,CPF_A,a.id);
  cached.recordId='outro-registro';cached.payload.data.basic.tax_id.number=CPF_B;
  const saved=await f.reports.reprocessLastResponse();
  assert.equal(saved.recordId,a.id);
  assert.equal(f.reports.readFor(ACCOUNT,CPF_A,a.id).payload.data.basic.tax_id.number,CPF_A);
}));

test('conta, CPF, tipo ou código incompatíveis com o histórico bloqueiam a geração',()=>fixture(async f=>{
  const a=await f.begin(CPF_A,CODE_A);
  for(const change of [{account:'other@example.invalid'},{cpf:CPF_B,payload:payload(CPF_B)},{queryCode:CODE_B}]){
    await assert.rejects(f.reports.processReceived({...f.received(a,CPF_A,CODE_A),...change}),/conta|histórico|identidade|código/i);
  }
  for(const kind of ['pis','company']){
    const row=kind==='pis'?await f.history.begin(ACCOUNT,CPF_A,'pis'):await f.history.beginCompany(ACCOUNT,'11222333000181');
    await assert.rejects(f.reports.processReceived(f.received(row,CPF_A,undefined)),/histórico|identidade|pessoa/i);
  }
  assert.equal(f.renders(),0);
  assert.equal((await f.history.findById(ACCOUNT,a.id)).status,'pending');
}));

test('PDF incompatível é rejeitado antes de renderizar e na fronteira de persistência',()=>fixture(async f=>{
  const b=await f.begin(CPF_B,CODE_B);
  const binding={account:ACCOUNT,recordId:b.id,cpf:CPF_B,queryCode:CODE_B};
  const report={cpf:CPF_A,consultedAt:'2026-11-11T00:00:00Z',queryCode:CODE_B,data:{}};
  await assert.rejects(f.reports.exportReport({...binding,report}),/CPF|identidade|corresponde/i);
  for(const identity of [
    {account:ACCOUNT,kind:'person',document:CPF_A,queryCode:CODE_B},
    {account:'other@example.invalid',kind:'person',document:CPF_B,queryCode:CODE_B},
    {account:ACCOUNT,kind:'person',document:CPF_B,queryCode:CODE_A},
    {account:ACCOUNT,kind:'pis',document:CPF_B,queryCode:CODE_B}
  ])await assert.rejects(f.history.addPdf(b.id,join(f.dir,'incompativel.pdf'),identity),/histórico|identidade|corresponde/i);
  assert.equal(f.renders(),0);
  assert.equal((await f.history.findById(ACCOUNT,b.id)).status,'pending');
  assert.deepEqual((await f.history.findById(ACCOUNT,b.id)).pdfPaths,[]);
}));

test('troca de conta ou de código durante a geração não vincula o PDF',()=>fixture(async f=>{
  const a=await f.begin(CPF_A,CODE_A);
  f.beforeSaveReturns(async()=>f.setAccount('other@example.invalid'));
  await assert.rejects(f.reports.processReceived(f.received(a,CPF_A,CODE_A)),/conta|sessão/i);
  f.setAccount(ACCOUNT);
  f.beforeSaveReturns(async()=>f.history.setCode(a.id,CODE_B));
  await assert.rejects(f.reports.reprocessLastResponse(),/histórico|identidade|código/i);
  const stored=await f.history.findById(ACCOUNT,a.id);
  assert.equal(stored.status,'pending');assert.deepEqual(stored.pdfPaths,[]);
}));

test('falha de normalização conserva resposta vinculada para reprocessamento e clear elimina a sessão',()=>fixture(async f=>{
  const a=await f.begin(CPF_A,CODE_A), result=f.received(a,CPF_A,CODE_A);
  delete result.payload.data.lawsuits;
  await assert.rejects(f.reports.processReceived(result),/Dataset/);
  assert.deepEqual(f.reports.status(),{hasResponse:true,hasReport:false});
  f.setAccount('other@example.invalid');
  await assert.rejects(f.reports.reprocessLastResponse(),/conta|sessão/i);
  f.reports.clear();assert.deepEqual(f.reports.status(),{hasResponse:false,hasReport:false});
  await assert.rejects(f.reports.reprocessLastResponse(),/resposta/i);
}));

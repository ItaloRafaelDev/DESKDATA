import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CpiWorkflowStore } from '../src/main/cpi/workflow-store.ts';
import { executeCpiPersonCycle } from '../src/main/cpi/full-cycle.ts';
import { PersonReportService } from '../src/main/person-reports.ts';
import { renderReportHtml } from '../src/shared/report.ts';
import { assessCpiPerson } from '../src/main/cpi/person-rules.ts';
import { normalizeDeskdataResponse } from '../src/shared/normalizer.ts';

const account='judicial@example.invalid',cpf='52998224725',code='Q-AAAAAAAAAA';
const recordId='123e4567-e89b-12d3-a456-426614174000',ids={pesquisaId:'537987',solicitacaoId:'275064'};
const protector={isAvailable:async()=>true,encrypt:async value=>Buffer.from(value),decrypt:async value=>({result:value.toString(),shouldReEncrypt:false})};
const payload=lawsuits=>({status:{code:4000},data:{basic:{tax_id:{number:cpf}},phones:{items:[]},addresses:{items:[]},emails:{items:[]},lawsuits}});

for(const [lawsuits,reason] of [
  [{total:2,items:[]},'total_mismatch'],
  [{items:[{court_type:'Criminal'},{court_type:23}]},'invalid_court_type'],
  [{items:[{number:'PROCESSO-FICTICIO',competencia:['Criminal']}]},'invalid_court_type']
]){
  test(`judicial: ciclo persiste ${reason}, conserva histórico e não chega ao envio`,async()=>{
    const directory=await mkdtemp(join(tmpdir(),'deskdata-judicial-'));
    try{
      let store=new CpiWorkflowStore(directory,protector),gets=0;
      const record={id:recordId,kind:'person',account,cpf,status:'pending',queryCode:code,pdfPaths:[]};
      const before=structuredClone(record);
      const forbidden=async()=>{assert.fail('Não deve consultar, gerar PDF, anexar ou submeter');};
      const services={account,ids,outputFolder:directory,getCpf:async()=>cpf,
        getJob:()=>store.get(account,ids),claim:()=>store.claim(account,ids),mark:(stage,updates)=>store.mark(account,ids,stage,updates),
        findLatest:async()=>record,checkByCode:async()=>{gets++;return {state:'ready',queryCode:code,payload:payload(lawsuits)};},
        beginHistory:forbidden,setQueryCode:forbidden,getCredits:forbidden,verifyPaidBalance:forbidden,
        paidApproved:forbidden,submitCpf:forbidden,savePdf:forbidden,uploadAndSave:forbidden,finalizeSubmitted:forbidden};
      const result=await executeCpiPersonCycle(services);
      assert.equal(result.state,'review_required');assert.equal(result.reviewReason,reason);
      assert.equal(gets,1);assert.deepEqual(record,before);
      store=new CpiWorkflowStore(directory,protector);
      const job=await store.get(account,ids);
      assert.equal(job.stage,'review_required');assert.equal(job.reviewReason,reason);assert.equal(job.historyRecordId,recordId);
      services.getCpf=forbidden;
      assert.equal((await executeCpiPersonCycle(services)).reviewReason,reason);
      assert.equal(gets,1);
    }finally{await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
  });
}

test('judicial: regra CPI classifica ausência, vazio e desconhecido; só formato inválido vai para revisão',()=>{
  for(const [item,expected] of [[{},'information'],[{court_type:''},'information'],
    [{court_type:'DADO-PRIVADO-NAO-REGISTRAR'},'information'],[{court_type:'Civil',competencia:'Criminal'},'restrictions'],
    [{court_type:'',competence:'Criminal'},'restrictions']]){
    const assessment=assessCpiPerson(normalizeDeskdataResponse(payload({items:[item]})));
    assert.equal(assessment.classification.state,'classified');
    assert.equal(assessment.classification.result,expected);
  }
  const invalid=assessCpiPerson(normalizeDeskdataResponse(payload({items:[{court_type:'DADO-PRIVADO',competence:23}]})));
  assert.equal(invalid.classification.state,'review_required');
  assert.equal(invalid.issues[0].code,'invalid_court_type');assert.equal(invalid.issues[0].itemIndex,0);
  assert.doesNotMatch(JSON.stringify(invalid.issues),/DADO-PRIVADO|529982|Criminal/);
});

test('judicial: resposta incompleta fica recuperável sem PDF, sem ready e sem novo histórico',async()=>{
  const record={id:recordId,account,cpf,kind:'person',queryCode:code,status:'pending',pdfPaths:[]};
  const service=new PersonReportService({currentAccount:()=>account,getOutputFolder:async()=>tmpdir(),
    history:{findById:async()=>record,addPdf:async()=>{assert.fail('Não vincular PDF incompleto');}},
    savePdf:async()=>{assert.fail('Não renderizar resposta incompleta');}});
  await assert.rejects(service.processReceived({account,recordId,cpf,queryCode:code,consultedAt:'2026-11-11',
    payload:payload({total:3,items:[{court_type:'Civil'}]})}),/lawsuits/);
  assert.equal(record.status,'pending');assert.deepEqual(record.pdfPaths,[]);
  assert.deepEqual(service.status(),{hasResponse:true,hasReport:false});
  await assert.rejects(service.reprocessLastResponse(),/lawsuits/);
});

test('judicial: persistência aceita apenas códigos de revisão conhecidos',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'deskdata-judicial-'));
  try{
    const store=new CpiWorkflowStore(directory,protector);await store.claim(account,ids);
    await assert.rejects(store.mark(account,ids,'review_required',{reviewReason:'DADO-PRIVADO-NAO-REGISTRAR'}));
    assert.equal((await store.get(account,ids)).stage,'claimed');
  }finally{await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});

test('judicial: geração manual preserva todos os processos e concorda com a decisão CPI',async()=>{
  const lawsuits={total:3,items:[{number:'FICTICIO-A',court_type:'Civil'},{number:'FICTICIO-B',court_type:'Criminal'},
    {number:'FICTICIO-C',court_type:'Trabalhista'}]};
  const record={id:recordId,account,cpf,kind:'person',queryCode:code,status:'pending',pdfPaths:[]};
  let html='';
  const service=new PersonReportService({currentAccount:()=>account,getOutputFolder:async()=>tmpdir(),
    history:{findById:async()=>record,addPdf:async(_id,path)=>{record.status='ready';record.pdfPaths.push(path);}},
    savePdf:async(_folder,report)=>{
      assert.equal(assessCpiPerson(report.data).classification.result,'restrictions');html=renderReportHtml(report);
      return {path:join(tmpdir(),'RELATORIO_FICTICIO.pdf'),savedAt:'2026-11-11',queryCode:code};
    }});
  await service.processReceived({account,recordId,cpf,queryCode:code,consultedAt:'2026-11-11',payload:payload(lawsuits)});
  for(const number of ['FICTICIO-A','FICTICIO-B','FICTICIO-C'])assert.ok(html.includes(number));
  assert.equal(record.status,'ready');assert.equal(record.pdfPaths.length,1);
});

test('judicial: PDF ready legado não substitui relatório da resposta usada na classificação atual',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'deskdata-judicial-'));
  try{
    const oldPath=join(directory,`RELATORIO_${cpf}_2026-11-10.pdf`),newPath=join(directory,'CPI_537987_275064_2026-11-11.pdf');
    const oldBytes=Buffer.from('%PDF-1.4\n'+'PROCESSO-LEGADO\n'.repeat(20));await writeFile(oldPath,oldBytes);
    const record={id:recordId,account,cpf,kind:'person',queryCode:code,status:'ready',pdfPaths:[oldPath]};
    const store=new CpiWorkflowStore(directory,protector);
    let renders=0,uploads=0;
    const forbidden=async()=>{assert.fail('Não iniciar nova consulta paga');};
    const current=payload({total:2,items:[{number:'ATUAL-A',court_type:'Civil'},{number:'ATUAL-B',court_type:'Criminal'}]});
    const services={account,ids,outputFolder:directory,getCpf:async()=>cpf,
      getJob:()=>store.get(account,ids),claim:()=>store.claim(account,ids),mark:(stage,updates)=>store.mark(account,ids,stage,updates),
      findLatest:async()=>record,checkByCode:async()=>({state:'ready',queryCode:code,payload:current}),
      beginHistory:forbidden,setQueryCode:forbidden,getCredits:forbidden,verifyPaidBalance:forbidden,paidApproved:forbidden,submitCpf:forbidden,
      savePdf:async(document,id,queryCode,data)=>{
        assert.equal(document,cpf);assert.equal(id,recordId);assert.equal(queryCode,code);renders++;
        const html=renderReportHtml({cpf,consultedAt:'2026-11-11',data});
        assert.match(html,/ATUAL-A/);assert.match(html,/ATUAL-B/);
        await writeFile(newPath,'%PDF-1.4\n'+html);record.pdfPaths.push(newPath);
      },
      uploadAndSave:async(path,classification)=>{
        uploads++;assert.equal(path,newPath);assert.equal(classification,'restrictions');return 'unverified';
      },finalizeSubmitted:forbidden};
    assert.equal((await executeCpiPersonCycle(services)).state,'verification_required');
    assert.equal(renders,1);assert.equal(uploads,1);assert.deepEqual(await readFile(oldPath),oldBytes);
    assert.equal((await executeCpiPersonCycle(services)).state,'review_required');
    assert.equal(renders,1);assert.equal(uploads,1);
  }finally{await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});

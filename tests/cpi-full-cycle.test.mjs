import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCpiPersonCycle } from '../src/main/cpi/full-cycle.ts';
import { tmpdir } from 'node:os';
import { CpiWorkflowStore } from '../src/main/cpi/workflow-store.ts';

// CPF fictício válido apenas para testes locais.
const CPF='52998224725';
const ids={pesquisaId:'573987',solicitacaoId:'275064'};
const data={status:{code:4000},data:{
  basic:{tax_id:{number:CPF}},phones:{items:[]},addresses:{items:[]},emails:{items:[]},lawsuits:{items:[]}
}};
function services(overrides={}){
  const events=[];
  let job=null;
  let record=null;
  const s={
    account:'test@example.invalid',ids,outputFolder:tmpdir(),
    getCpf:async()=>CPF,getJob:async()=>job,
    claim:async()=>{job={...ids,account:s.account,stage:'claimed',updatedAt:new Date().toISOString()};return job;},
    mark:async(stage,update={})=>{events.push(stage);job={...job,...update,stage};return job;},
    findLatest:async()=>record,
    beginHistory:async()=>{record={id:'123e4567-e89b-12d3-a456-426614174000',kind:'person',cpf:CPF,account:s.account,status:'uncertain',queryCode:undefined,pdfPaths:[]};return record;},
    setQueryCode:async(_id,code)=>{record.queryCode=code;},
    getCredits:async()=>10,verifyPaidBalance:async()=>events.push('reserved'),paidApproved:async()=>true,
    submitCpf:async()=>({state:'ready',queryCode:'Q-AAAAAAAAAA',payload:data}),
    fetchByCode:async()=>({queryCode:'Q-AAAAAAAAAA',payload:data}),
    savePdf:async()=>{record.status='ready';},
    uploadAndSave:async()=>('confirmed'),
    closeCompletedDetail:async()=>events.push('closed_detail'),
    ...overrides
  };
  return {s,events,setRecord:r=>{record=r;}};
}
test('sem aprovação não executa POST, reserva ou envio',async()=>{
  const {s,events}=services({paidApproved:async()=>false,submitCpf:async()=>{throw Error('POST indevido');}});
  const result=await executeCpiPersonCycle(s);
  assert.equal(result.state,'review_required');assert.deepEqual(events,[]);
});
test('reserva orçamento antes do primeiro POST e não repete com histórico existente',async()=>{
  const {s,events}=services();
  await assert.rejects(executeCpiPersonCycle(s),/PDF|pasta/i);
  assert.ok(events.indexOf('reserved')<events.indexOf('query_started'));
});
test('POST pendente retorna sem upload ou reenvio',async()=>{
  const {s,events}=services({submitCpf:async(_cpf,onCode)=>{await onCode('Q-AAAAAAAAAA');return {state:'pending',queryCode:'Q-AAAAAAAAAA'};},uploadAndSave:async()=>{throw Error('Envio indevido');}});
  const result=await executeCpiPersonCycle(s);
  assert.equal(result.state,'pending');assert.ok(events.includes('query_pending'));assert.equal(events.filter(v=>v==='reserved').length,1);
});
test('resposta judicial sem dataset completo bloqueia envio',async()=>{
  const partial={status:{code:4000},data:{basic:{tax_id:{number:CPF}}}};
  const {s,events}=services({submitCpf:async()=>({state:'ready',payload:partial}),uploadAndSave:async()=>{throw Error('Envio indevido');}});
  await assert.rejects(executeCpiPersonCycle(s),/Dataset/);
  assert.equal(events.includes('submit_started'),false);
});
import {mkdtemp,realpath,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';

test('ciclo completo simulado: um POST, PDF correto, resposta Há Informações e estado concluído',async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'deskdata-cpi-cycle-')));
  try{
    let uploadCount=0, savedPath='';
    const {s,events}=services({
      outputFolder:dir,
      savePdf:async(cpf,_recordId,_code,_data)=>{
        savedPath=join(dir,`RELATORIO_${cpf}_2026-11-10.pdf`);
        await writeFile(savedPath,'%PDF-1.4\n'+'x'.repeat(150));
        const record=await s.findLatest(cpf);
        record.status='ready';record.pdfPaths=[savedPath];
      },
      uploadAndSave:async(path,category)=>{
        assert.equal(path,savedPath);assert.equal(category,'information');uploadCount++;return 'confirmed';
      }
    });
    const result=await executeCpiPersonCycle(s);
    assert.equal(result.state,'completed');assert.equal(uploadCount,1);
    assert.equal(events.filter(e=>e==='reserved').length,1);
    assert.ok(events.indexOf('submit_started')<events.indexOf('completed'));
    assert.ok(events.indexOf('review_required')<events.indexOf('closed_detail'));
    assert.ok(events.indexOf('closed_detail')<events.indexOf('completed'));
    assert.equal(events.filter(e=>e==='closed_detail').length,1);
    const again=await executeCpiPersonCycle(s);
    assert.equal(again.state,'completed');assert.equal(uploadCount,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('ciclo completo mede consulta, PDF e fechamento na ordem, sem receber CPF',async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'deskdata-cpi-timing-')));
  try{
    const steps=[];
    const {s}=services({
      outputFolder:dir,
      timer:{step:async(name,work)=>{assert.equal(typeof name,'string');steps.push(name);return work();}},
      savePdf:async cpf=>{
        const path=join(dir,`RELATORIO_${cpf}_2026-11-10.pdf`);
        await writeFile(path,'%PDF-1.4\n'+'x'.repeat(150));
        const latest=await s.findLatest(cpf);latest.status='ready';latest.pdfPaths=[path];
      }
    });
    assert.equal((await executeCpiPersonCycle(s)).state,'completed');
    assert.deepEqual(steps,['deskdata_credits','deskdata_query','report_pdf','cpi_close_detail']);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('consulta existente mede o GET por código, nunca um POST',async()=>{
  const steps=[];
  const {s,setRecord}=services({timer:{step:async(name,work)=>{steps.push(name);return work();}},
    submitCpf:async()=>{throw Error('POST indevido');},savePdf:async()=>{throw Error('PDF interrompido');}});
  setRecord({id:'123e4567-e89b-12d3-a456-426614174000',kind:'person',cpf:CPF,account:s.account,status:'ready',queryCode:'Q-AAAAAAAAAA',pdfPaths:[]});
  await assert.rejects(executeCpiPersonCycle(s),/PDF interrompido/);
  assert.deepEqual(steps,['deskdata_fetch','report_pdf']);
});

test('processo Criminal vira restrições; envio sem confirmação fica travado',async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'deskdata-cpi-cycle-')));
  try{
    const payload={...data,data:{...data.data,lawsuits:{items:[{court_type:'Criminal',number:'000'}]}}};
    let uploads=0;
    const {s,events}=services({outputFolder:dir,submitCpf:async()=>({state:'ready',payload}),
      savePdf:async(cpf)=>{
        const path=join(dir,`RELATORIO_${cpf}_2026-11-10.pdf`);
        await writeFile(path,'%PDF-1.4\n'+'x'.repeat(150));
        const latest=await s.findLatest(cpf);latest.status='ready';latest.pdfPaths=[path];
      },
      uploadAndSave:async(_path,result)=>{assert.equal(result,'restrictions');uploads++;return 'unverified';}
    });
    assert.equal((await executeCpiPersonCycle(s)).state,'verification_required');
    assert.equal((await executeCpiPersonCycle(s)).state,'review_required');
    assert.equal(uploads,1);
    assert.ok(events.includes('verification_required'));
    assert.equal(events.includes('closed_detail'),false);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('resposta persistida com falha no fechamento nao e reenviada e exige revisao',async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'deskdata-cpi-close-')));
  try{
    let uploads=0,closeCalls=0;
    const {s,events}=services({outputFolder:dir,
      savePdf:async cpf=>{
        const path=join(dir,`RELATORIO_${cpf}_2026-11-10.pdf`);
        await writeFile(path,'%PDF-1.4\n'+'x'.repeat(150));
        const latest=await s.findLatest(cpf);latest.status='ready';latest.pdfPaths=[path];
      },
      uploadAndSave:async()=>{uploads++;return 'confirmed';},
      closeCompletedDetail:async()=>{closeCalls++;throw Error('Shadowbox indisponivel');}
    });
    const result=await executeCpiPersonCycle(s);
    assert.equal(result.state,'review_required');
    assert.equal(uploads,1);assert.equal(closeCalls,1);
    assert.ok(events.includes('review_required'));
    assert.equal(events.includes('completed'),false);
    const second=await executeCpiPersonCycle(s);
    assert.equal(second.state,'review_required');
    assert.equal(uploads,1);assert.equal(closeCalls,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('falha no fechamento persiste pendência após reinício e impede segundo envio',async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'deskdata-cpi-close-store-')));
  const account='test@example.invalid';
  const protector={isAvailable:async()=>true,encrypt:async text=>Buffer.from(text),decrypt:async bytes=>({result:bytes.toString()})};
  try{
    let store=new CpiWorkflowStore(dir,protector),uploads=0;
    const {s}=services({
      outputFolder:dir,
      getJob:()=>store.get(account,ids),
      claim:()=>store.claim(account,ids),
      mark:(stage,updates)=>store.mark(account,ids,stage,updates),
      savePdf:async cpf=>{
        const path=join(dir,`RELATORIO_${cpf}_2026-11-10.pdf`);
        await writeFile(path,'%PDF-1.4\n'+'x'.repeat(150));
        const record=await s.findLatest(cpf);record.status='ready';record.pdfPaths=[path];
      },
      uploadAndSave:async()=>{uploads++;return 'confirmed';},
      closeCompletedDetail:async()=>{throw Error('Fechamento do modal indisponível');}
    });
    assert.equal((await executeCpiPersonCycle(s)).state,'review_required');
    assert.equal((await store.get(account,ids)).stage,'review_required');
    assert.equal((await store.listPending(account,0,10)).total,1);
    store=new CpiWorkflowStore(dir,protector);
    s.getCpf=async()=>{throw Error('Não reabrir solicitação respondida');};
    assert.equal((await executeCpiPersonCycle(s)).state,'review_required');
    assert.equal(uploads,1);
    assert.equal((await store.get(account,ids)).stage,'review_required');
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

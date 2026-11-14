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
    recordNotSubmitted:async()=>{events.push('not_submitted_proven');job={...job,stage:'pdf_ready'};return job;},
    findLatest:async()=>record,
    beginHistory:async()=>{record={id:'123e4567-e89b-12d3-a456-426614174000',kind:'person',cpf:CPF,account:s.account,status:'uncertain',queryCode:undefined,pdfPaths:[]};return record;},
    setQueryCode:async(_id,code)=>{record.queryCode=code;},
    getCredits:async()=>10,verifyPaidBalance:async()=>events.push('reserved'),paidApproved:async()=>true,
    submitCpf:async()=>({state:'ready',queryCode:'Q-AAAAAAAAAA',payload:data}),
    checkByCode:async()=>({state:'ready',queryCode:'Q-AAAAAAAAAA',payload:data}),
    savePdf:async()=>{record.status='ready';},
    uploadAndSave:async()=>('confirmed'),
    finalizeSubmitted:async()=>{events.push('closed_detail');return {persistence:'confirmed',auxiliary404:false,modal:'closed',listing:'refreshed',browserReleased:true};},
    ...overrides
  };
  return {s,events,setRecord:r=>{record=r;}};
}
// E2 (D1): falta de autorização é condição sistêmica; o ciclo lança erro (o agente pausa) em vez de
// devolver review_required sem marcar o item, o que faria o FULL AUTO contínuo reabri-lo a cada ciclo.
test('sem aprovação não executa POST, reserva ou envio e pausa o agente sem marcar o item',async()=>{
  const {s,events}=services({paidApproved:async()=>false,submitCpf:async()=>{throw Error('POST indevido');}});
  await assert.rejects(executeCpiPersonCycle(s),/Autorize novas consultas/);
  assert.deepEqual(events,[]);
});
test('E2: GET por código ainda em processamento devolve pending sem polling, POST, PDF ou envio',async()=>{
  let gets=0;
  const {s,events,setRecord}=services({checkByCode:async()=>{gets++;return {state:'pending',queryCode:'Q-AAAAAAAAAA'};},
    submitCpf:async()=>{throw Error('POST indevido');},getCredits:async()=>{throw Error('Saldo indevido');},
    savePdf:async()=>{throw Error('PDF indevido');},uploadAndSave:async()=>{throw Error('Envio indevido');}});
  setRecord({id:'123e4567-e89b-12d3-a456-426614174000',kind:'person',cpf:CPF,account:s.account,status:'pending',queryCode:'Q-AAAAAAAAAA',pdfPaths:[]});
  const result=await executeCpiPersonCycle(s);
  assert.equal(result.state,'pending');assert.equal(gets,1);
  assert.deepEqual(events,['query_pending']);
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
        savedPath=join(dir,'CPI_573987_275064_2026-11-10.pdf');
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
    assert.ok(events.indexOf('submit_started')<events.indexOf('closed_detail'));
    assert.ok(events.indexOf('closed_detail')<events.indexOf('completed'));
    // submit_started (bloqueante) permanece até a leitura independente decidir; sem revisão intermediária.
    assert.equal(events.includes('review_required'),false);
    assert.equal(result.warnings,undefined);
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
        const path=join(dir,'CPI_573987_275064_2026-11-10.pdf');
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

test('PDF legado não é enviado: o ciclo regera o PDF CPI por GET, sem novo POST',async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'deskdata-cpi-legacy-')));
  try{
    const legacy=join(dir,`RELATORIO_${CPF}_2026-11-01.pdf`),fresh=join(dir,'CPI_573987_275064_2026-11-12.pdf');
    await writeFile(legacy,'%PDF-1.4\n'+'legado'.repeat(40));
    let fetched=0,uploaded=null;
    const {s,setRecord}=services({outputFolder:dir,
      submitCpf:async()=>{throw Error('POST indevido');},getCredits:async()=>{throw Error('Saldo indevido');},
      checkByCode:async()=>{fetched++;return {state:'ready',queryCode:'Q-AAAAAAAAAA',payload:data};},
      savePdf:async cpf=>{await writeFile(fresh,'%PDF-1.4\n'+'x'.repeat(150));const r=await s.findLatest(cpf);r.pdfPaths.push(fresh);},
      uploadAndSave:async path=>{uploaded=path;return 'confirmed';}});
    setRecord({id:'123e4567-e89b-12d3-a456-426614174000',kind:'person',cpf:CPF,account:s.account,status:'ready',queryCode:'Q-AAAAAAAAAA',pdfPaths:[legacy]});
    assert.equal((await executeCpiPersonCycle(s)).state,'completed');
    assert.equal(fetched,1);assert.equal(uploaded,fresh);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('PDF gerado com nome de outra pesquisa bloqueia o envio',async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'deskdata-cpi-other-')));
  try{
    let uploads=0;
    const {s,events}=services({outputFolder:dir,
      savePdf:async cpf=>{const path=join(dir,'CPI_573988_275064_2026-11-12.pdf');await writeFile(path,'%PDF-1.4\n'+'x'.repeat(150));
        const r=await s.findLatest(cpf);r.status='ready';r.pdfPaths=[path];},
      uploadAndSave:async()=>{uploads++;return 'confirmed';}});
    await assert.rejects(executeCpiPersonCycle(s),/PDF correspondente/);
    assert.equal(uploads,0);assert.equal(events.includes('submit_started'),false);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('processo Criminal vira restrições; envio sem confirmação fica travado',async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'deskdata-cpi-cycle-')));
  try{
    const payload={...data,data:{...data.data,lawsuits:{items:[{court_type:'Criminal',number:'000'}]}}};
    let uploads=0;
    const {s,events}=services({outputFolder:dir,submitCpf:async()=>({state:'ready',payload}),
      savePdf:async(cpf)=>{
        const path=join(dir,'CPI_573987_275064_2026-11-10.pdf');
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

// ---------- finalização: persistência decide; modal e listagem são avisos ----------
const report=(extra={})=>({persistence:'confirmed',auxiliary404:false,modal:'closed',listing:'refreshed',browserReleased:true,...extra});
async function withCycleDir(name,run){
  const dir=await realpath(await mkdtemp(join(tmpdir(),`deskdata-cpi-${name}-`)));
  try{return await run(dir);}finally{await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
}
function pdfWriter(dir,s){
  return async cpf=>{
    const path=join(dir,'CPI_573987_275064_2026-11-10.pdf');
    await writeFile(path,'%PDF-1.4\n'+'x'.repeat(150));
    const latest=await s.findLatest(cpf);latest.status='ready';latest.pdfPaths=[path];
  };
}
/** Ciclo com POST Deskdata contado; o segundo ciclo nunca pode repetir POST, anexo ou envio. */
function countedCycle(dir,overrides){
  const counts={posts:0,uploads:0,finalizes:0};
  const {s,events}=services({outputFolder:dir,
    submitCpf:async()=>{counts.posts++;return {state:'ready',queryCode:'Q-AAAAAAAAAA',payload:data};},
    uploadAndSave:async()=>{counts.uploads++;return 'confirmed';},...overrides(counts)});
  s.savePdf=pdfWriter(dir,s);
  return {s,events,counts};
}

test('modal conflitante com persistência confirmada: conclui, mas retém o navegador (browserHold), sem reenvio',()=>withCycleDir('ui-warn',async dir=>{
  const {s,events,counts}=countedCycle(dir,c=>({finalizeSubmitted:async()=>{c.finalizes++;
    return report({modal:'close_failed',listing:'not_attempted',browserReleased:false});}}));
  const result=await executeCpiPersonCycle(s);
  assert.equal(result.state,'completed');assert.deepEqual(result.warnings,['modal_open']);
  assert.equal(result.browserHold,true);
  assert.match(result.message,/fechada manualmente/);assert.doesNotMatch(result.message,/próxima solicitação liberada/);
  assert.ok(events.includes('completed'));assert.equal(events.includes('verification_required'),false);
  const again=await executeCpiPersonCycle(s);
  assert.equal(again.state,'completed');assert.deepEqual(counts,{posts:1,uploads:1,finalizes:1});
}));

test('erro isolado de atualização da listagem não impede concluir nem gera nova consulta',()=>withCycleDir('listing',async dir=>{
  const {s,counts}=countedCycle(dir,c=>({finalizeSubmitted:async()=>{c.finalizes++;return report({modal:'auto_closed',listing:'stale'});}}));
  const result=await executeCpiPersonCycle(s);
  assert.equal(result.state,'completed');assert.deepEqual(result.warnings,['listing_stale']);
  assert.equal(result.browserHold,undefined,'listagem desatualizada com modal fechado não retém o navegador');
  await executeCpiPersonCycle(s);
  assert.deepEqual(counts,{posts:1,uploads:1,finalizes:1});
}));

test('404 auxiliar com persistência comprovada conclui com aviso',()=>withCycleDir('aux404',async dir=>{
  const {s,counts}=countedCycle(dir,c=>({uploadAndSave:async()=>{c.uploads++;return 'confirmed_auxiliary_404';},
    finalizeSubmitted:async()=>{c.finalizes++;return report({auxiliary404:true});}}));
  const result=await executeCpiPersonCycle(s);
  assert.equal(result.state,'completed');assert.deepEqual(result.warnings,['auxiliary_404']);
  assert.match(result.message,/cpi_api_request\.aspx/);
  assert.deepEqual(counts,{posts:1,uploads:1,finalizes:1});
}));

for(const [persistence,pattern,browserReleased] of [['absent',/não exibe a resposta completa/,true],['unavailable',/não pôde ser lida/,true],
  ['absent',/não exibe a resposta completa/,false],['unavailable',/não pôde ser lida/,false]]){
  test(`persistência ${persistence} (navegador ${browserReleased?'liberado':'retido'}) vira verificação manual, sem reenvio`,()=>withCycleDir(`p-${persistence}`,async dir=>{
    const {s,events,counts}=countedCycle(dir,c=>({finalizeSubmitted:async()=>{c.finalizes++;
      return {persistence,auxiliary404:true,modal:'not_attempted',listing:'not_attempted',browserReleased};}}));
    const result=await executeCpiPersonCycle(s);
    assert.equal(result.state,'verification_required');assert.match(result.message,pattern);
    assert.deepEqual(result.warnings,browserReleased?['auxiliary_404']:['auxiliary_404','modal_open']);
    assert.equal(result.browserHold,browserReleased?undefined:true);
    assert.equal(events.includes('completed'),false);
    assert.equal((await executeCpiPersonCycle(s)).state,'review_required');
    assert.deepEqual(counts,{posts:1,uploads:1,finalizes:1});
  }));
}

test('falha inesperada na finalização vira verificação manual e retém o navegador, sem reenvio',()=>withCycleDir('fin-throw',async dir=>{
  const {s,counts}=countedCycle(dir,c=>({finalizeSubmitted:async()=>{c.finalizes++;throw Error('Shadowbox indisponivel');}}));
  const result=await executeCpiPersonCycle(s);
  assert.equal(result.state,'verification_required');assert.equal(result.browserHold,true);
  assert.equal((await executeCpiPersonCycle(s)).state,'review_required');
  assert.deepEqual(counts,{posts:1,uploads:1,finalizes:1});
}));

test('timeout comprovadamente anterior ao envio mantém pdf_ready e retém o navegador sem marcar revisão',()=>withCycleDir('pre-submit-timeout',async dir=>{
  const {s,events}=countedCycle(dir,c=>({uploadAndSave:async()=>{c.uploads++;return 'not_submitted_held';}}));
  const result=await executeCpiPersonCycle(s);
  assert.equal(result.state,'pending');assert.equal(result.browserHold,true);
  assert.match(result.message,/nenhum envio foi realizado/i);
  assert.equal((await s.getJob()).stage,'pdf_ready');
  assert.ok(events.includes('submit_started'));assert.ok(events.includes('not_submitted_proven'));
  assert.ok(!events.includes('review_required'));assert.ok(!events.includes('verification_required'));
}));

const protector={isAvailable:async()=>true,encrypt:async text=>Buffer.from(text),decrypt:async bytes=>({result:bytes.toString()})};
function storeCycle(dir,store,overrides){
  const account='test@example.invalid';
  const cycle=countedCycle(dir,c=>({getJob:()=>store.current.get(account,ids),claim:()=>store.current.claim(account,ids),
    mark:(stage,updates)=>store.current.mark(account,ids,stage,updates),...overrides(c)}));
  return {...cycle,account};
}

test('prazo estourado na conferência e reabertura do aplicativo: item bloqueado, nenhum POST ou envio repetido',()=>withCycleDir('timeout-reopen',async dir=>{
  const store={current:new CpiWorkflowStore(dir,protector)};
  const {s,counts,account}=storeCycle(dir,store,c=>({finalizeSubmitted:async()=>{c.finalizes++;
    throw Object.assign(new Error('Tempo limite excedido (cpi_verify_save)'),{name:'TimeoutError'});}}));
  assert.equal((await executeCpiPersonCycle(s)).state,'verification_required');
  assert.equal((await store.current.get(account,ids)).stage,'verification_required');
  assert.equal((await store.current.listPending(account,0,10)).total,1);
  // Reabertura: novo store sobre o mesmo arquivo cifrado; o detalhe nem é reaberto.
  store.current=new CpiWorkflowStore(dir,protector);
  s.getCpf=async()=>{throw Error('Não reabrir pesquisa com resultado incerto');};
  assert.equal((await executeCpiPersonCycle(s)).state,'review_required');
  assert.deepEqual(await store.current.stages(account,[ids]),['verification_required']);
  assert.deepEqual(counts,{posts:1,uploads:1,finalizes:1});
}));

test('envio com prazo estourado (unverified) e reabertura: bloqueado sem segundo POST',()=>withCycleDir('save-timeout',async dir=>{
  const store={current:new CpiWorkflowStore(dir,protector)};
  const {s,counts,account}=storeCycle(dir,store,c=>({uploadAndSave:async()=>{c.uploads++;return 'unverified';},
    finalizeSubmitted:async()=>{c.finalizes++;throw Error('Não conferir envio incerto');}}));
  assert.equal((await executeCpiPersonCycle(s)).state,'verification_required');
  store.current=new CpiWorkflowStore(dir,protector);
  s.getCpf=async()=>{throw Error('Não reabrir');};
  assert.equal((await executeCpiPersonCycle(s)).state,'review_required');
  assert.equal((await store.current.get(account,ids)).stage,'verification_required');
  assert.deepEqual(counts,{posts:1,uploads:1,finalizes:0});
}));

test('falha ao gravar completed mantém submit_started (bloqueante) e nunca reenvia',()=>withCycleDir('mark-fail',async dir=>{
  const store={current:new CpiWorkflowStore(dir,protector)};
  const {s,counts,account}=storeCycle(dir,store,c=>({finalizeSubmitted:async()=>{c.finalizes++;return report();}}));
  const mark=s.mark;
  s.mark=async(stage,updates)=>{if(stage==='completed')throw Error('Falha ao persistir a fila CPI.');return mark(stage,updates);};
  const result=await executeCpiPersonCycle(s);
  assert.equal(result.state,'review_required');assert.match(result.message,/conclusão local não foi gravada/);
  assert.equal((await store.current.get(account,ids)).stage,'submit_started');
  assert.equal((await store.current.listPending(account,0,10)).total,1);
  store.current=new CpiWorkflowStore(dir,protector);
  s.getCpf=async()=>{throw Error('Não reabrir');};
  assert.equal((await executeCpiPersonCycle(s)).state,'review_required');
  assert.deepEqual(counts,{posts:1,uploads:1,finalizes:1});
}));

// ---------- modo ensaio (somente desenvolvimento) ----------
function rehearsalServices(overrides={}){
  const {s,events,setRecord}=services({dryRun:true,closeWithoutSaving:async()=>events.push('closed_without_saving'),...overrides});
  setRecord({id:'123e4567-e89b-12d3-a456-426614174000',kind:'person',cpf:CPF,account:s.account,status:'ready',queryCode:'Q-AAAAAAAAAA',pdfPaths:[]});
  return {s,events};
}
async function withPdf(run){
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'deskdata-dryrun-'));
  try{return await run(dir,join(dir,'CPI_573987_275064_2026-11-13.pdf'),writeFile);}finally{await rm(dir,{recursive:true,force:true});}
}
test('ensaio: não marca submit_started, usa dry_run, fecha sem salvar e devolve dry_run',()=>withPdf(async(dir,pdfPath,writeFile)=>{
  const modes=[];
  const {s,events}=rehearsalServices({outputFolder:dir,
    savePdf:async(_cpf,_id)=>{await writeFile(pdfPath,'%PDF-1.4\n'+'x'.repeat(200));s.__record.pdfPaths.push(pdfPath);},
    uploadAndSave:async(_path,_result,mode)=>{modes.push(mode);return 'dry_run_ok';},
    finalizeSubmitted:async()=>{throw Error('Não finalizar no ensaio');}});
  s.__record=await s.findLatest();
  const result=await executeCpiPersonCycle(s);
  assert.equal(result.state,'dry_run');
  assert.match(result.message,/Ensaio concluído \(Há Informações\)/);
  assert.deepEqual(modes,['dry_run']);
  assert.ok(!events.includes('submit_started'));assert.ok(!events.includes('completed'));
  assert.equal(events.at(-1),'closed_without_saving');
  assert.equal(events.filter(e=>e==='pdf_ready').length,1);
}));
test('ensaio com falha antes do envio marca revisão sem fechar como concluída',()=>withPdf(async(dir,pdfPath,writeFile)=>{
  const {s,events}=rehearsalServices({outputFolder:dir,
    savePdf:async()=>{await writeFile(pdfPath,'%PDF-1.4\n'+'x'.repeat(200));s.__record.pdfPaths.push(pdfPath);},
    uploadAndSave:async()=>'not_submitted'});
  s.__record=await s.findLatest();
  const result=await executeCpiPersonCycle(s);
  assert.equal(result.state,'review_required');assert.ok(!events.includes('submit_started'));
  assert.ok(!events.includes('closed_without_saving'));
}));

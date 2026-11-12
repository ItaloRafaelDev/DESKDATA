import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,realpath,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CpiWorkflowStore } from '../src/main/cpi/workflow-store.ts';
import { executeCpiPersonCycle } from '../src/main/cpi/full-cycle.ts';
import { CpiFullAutoRunner } from '../src/main/cpi/full-auto-runner.ts';

const ids={pesquisaId:'537987',solicitacaoId:'275064'},cpf='52998224725',account='recovery@example.invalid';
const protector={isAvailable:async()=>true,encrypt:async text=>Buffer.from(text),decrypt:async buf=>({result:buf.toString(),shouldReEncrypt:false})};

for(const mode of ['unverified','exception','not_submitted','submit_started']){
  test(`CPI: reinício após ${mode} preserva PDF/classificação e bloqueia reenvio antes de abrir o detalhe`,async()=>{
    const dir=await realpath(await mkdtemp(join(tmpdir(),'deskdata-cpi-reconcile-')));
    try{
      const path=join(dir,`RELATORIO_${cpf}_2026-11-11.pdf`),bytes=Buffer.from('%PDF-1.4\n'+'fixture'.repeat(30));
      await writeFile(path,bytes);
      let store=new CpiWorkflowStore(dir,protector),uploads=0,opens=0,renders=0;
      const refreshedPath=join(dir,`RELATORIO_${cpf}_2026-11-11-02.pdf`);
      const record={id:'123e4567-e89b-12d3-a456-426614174000',account,cpf,kind:'person',status:'ready',queryCode:'Q-AAAAAAAAAA',pdfPaths:[path]};
      await store.claim(account,ids);
      await store.mark(account,ids,'pdf_ready',{historyRecordId:record.id,classification:'restrictions'});
      if(mode==='submit_started')await store.mark(account,ids,'submit_started');
      const s={account,ids,outputFolder:dir,getCpf:async()=>{opens++;return cpf;},
        getJob:()=>store.get(account,ids),claim:()=>store.claim(account,ids),mark:(stage,update)=>store.mark(account,ids,stage,update),
        findLatest:async()=>record,
        beginHistory:async()=>{throw Error('Novo histórico indevido');},setQueryCode:async()=>{throw Error('POST indevido');},
        paidApproved:async()=>{throw Error('Nova autorização indevida');},getCredits:async()=>{throw Error('Consulta indevida');},
        verifyPaidBalance:async()=>{throw Error('Consulta indevida');},submitCpf:async()=>{throw Error('POST indevido');},
        fetchByCode:async()=>({queryCode:record.queryCode,payload:{status:{code:4000},data:{basic:{tax_id:{number:cpf}},
          phones:{items:[]},emails:{items:[]},addresses:{items:[]},lawsuits:{items:[{court_type:'Criminal'}]}}}}),
        // Etapa 4: gerar outro PDF do mesmo snapshot; nunca sobrescrever o legado.
        savePdf:async(document,id,queryCode,data)=>{
          assert.equal(document,cpf);assert.equal(id,record.id);assert.equal(queryCode,record.queryCode);
          assert.equal(data.lawsuits.value.items[0].court_type,'Criminal');renders++;
          await writeFile(refreshedPath,bytes);record.pdfPaths.push(refreshedPath);
        },
        uploadAndSave:async(file,classification)=>{
          uploads++;assert.equal(file,refreshedPath);assert.equal(classification,'restrictions');
          assert.equal((await store.get(account,ids)).stage,'submit_started');
          if(mode==='exception')throw Error('Conexão perdida após POST');
          return mode;
        },closeCompletedDetail:async()=>{throw Error('Não fechar resposta incerta');}};
      const result=await executeCpiPersonCycle(s);
      assert.equal(result.state,mode==='not_submitted'||mode==='submit_started'?'review_required':'verification_required');
      const persisted=await store.get(account,ids);
      assert.equal(persisted.stage,mode==='not_submitted'?'review_required':mode==='submit_started'?'submit_started':'verification_required');
      assert.equal(persisted.classification,'restrictions');assert.equal(persisted.historyRecordId,record.id);
      assert.deepEqual(await readFile(path),bytes);
      const priorUploads=uploads,priorOpens=opens;
      store=new CpiWorkflowStore(dir,protector);
      s.getCpf=async()=>{throw Error('Não reabrir pesquisa potencialmente respondida');};
      const runner=new CpiFullAutoRunner(async()=>({found:1,outcomes:[await executeCpiPersonCycle(s)]}));
      await runner.start(30);await runner.pause();
      assert.equal(runner.status().phase,'paused');
      assert.equal((await executeCpiPersonCycle(s)).state,'review_required');
      assert.equal(uploads,priorUploads);assert.equal(opens,priorOpens);
      assert.equal(uploads,mode==='submit_started'?0:1);
      assert.equal(renders,mode==='submit_started'?0:1);
      assert.deepEqual(await readFile(path),bytes);
    }finally{await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
  });
}

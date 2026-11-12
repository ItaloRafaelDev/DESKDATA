import test from 'node:test';
import assert from 'node:assert/strict';
import { withMainProcess } from './helpers/main-process.mjs';

const A='52998224725',B='11144477735';
function payload(cpf){return {status:{code:4000},data:{basic:{tax_id:{number:cpf}},phones:{items:[]},addresses:{items:[]},emails:{items:[]},lawsuits:{items:[]}}};}
for(const mode of ['pending','error']){
  test(`IPC real: A concluída e B ${mode}, reprocessar e salvar novamente não alteram B`,()=>withMainProcess(async(cpf,onCode)=>{
    if(cpf===B){
      if(mode==='error')throw new Error('Falha simulada após envio');
      await onCode('Q-BBBBBBBBBB');return {state:'pending',queryCode:'Q-BBBBBBBBBB'};
    }
    await onCode('Q-AAAAAAAAAA');return {state:'ready',queryCode:'Q-AAAAAAAAAA',payload:payload(A)};
  },async({invoke})=>{
    const a=await invoke('api:query',A);assert.equal(a.state,'ready');
    if(mode==='error')await assert.rejects(invoke('api:query',B),/Falha simulada/);
    else assert.equal((await invoke('api:query',B)).state,'pending');
    const before=(await invoke('history:list')).find(row=>row.cpf===B);
    const reprocessed=await invoke('report:reprocess');
    const saved=await invoke('report:save-again');
    assert.equal(reprocessed.recordId,a.pdf.recordId);assert.equal(saved.recordId,a.pdf.recordId);
    const rows=await invoke('history:list');
    assert.deepEqual(rows.find(row=>row.cpf===B),before);
    assert.equal(rows.find(row=>row.cpf===A).pdfPaths.length,3);
  }));
}

test('IPC real: consulta manual grava duração de cada etapa com um id de correlação e sem CPF',()=>withMainProcess(async(cpf,onCode)=>{
  if(cpf===B)throw new TypeError('Falha simulada após envio');
  await onCode('Q-AAAAAAAAAA');return {state:'ready',queryCode:'Q-AAAAAAAAAA',payload:payload(A)};
},async({invoke,diagnostics})=>{
  assert.equal((await invoke('api:query',A)).state,'ready');
  const timing=()=>diagnostics.filter(row=>row.event.startsWith('timing_'));
  const first=timing();
  assert.deepEqual(first.map(row=>row.step??row.event),['deskdata_credits','deskdata_query','report_pdf','timing_cycle']);
  assert.equal(new Set(first.map(row=>row.correlationId)).size,1);
  assert.ok(first.every(row=>row.flow==='person'&&row.state==='success'&&Number.isFinite(row.durationMs)));
  assert.equal(first.at(-1).outcome,'ready');
  diagnostics.length=0;
  await assert.rejects(invoke('api:query',B),/Falha simulada/);
  const failed=timing();
  assert.deepEqual(failed.map(row=>`${row.step??row.event}:${row.state}`),['deskdata_credits:success','deskdata_query:failed','timing_cycle:failed']);
  assert.equal(failed[1].errorType,'TypeError');
  assert.notEqual(failed[0].correlationId,first[0].correlationId);
  assert.doesNotMatch(JSON.stringify([...first,...failed]),new RegExp(`${A}|${B}|Q-AAAAAAAAAA`));
}));

test('IPC real: sucesso imediato com CPF divergente é rejeitado sem PDF ou ready',()=>withMainProcess(async(_cpf,onCode)=>{
  await onCode('Q-BBBBBBBBBB');return {state:'ready',queryCode:'Q-BBBBBBBBBB',payload:payload(A)};
},async({invoke,renderCount})=>{
  await assert.rejects(invoke('api:query',B),/CPF|corresponde/i);
  assert.equal(renderCount(),0);
  const [row]=await invoke('history:list');
  assert.equal(row.cpf,B);assert.equal(row.status,'pending');assert.deepEqual(row.pdfPaths,[]);
  assert.deepEqual(await invoke('report:recovery-status'),{hasResponse:false,hasReport:false});
}));

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { OperationGate, GATE_BUSY_MESSAGE } from '../src/main/operation-gate.ts';
import { withMainProcess } from './helpers/main-process.mjs';

// E4 — garantias do OperationGate (unidade) e integração no processo principal. Só dados fictícios.
function deferred(){let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};}

test('E4: exclusiva registra o dono e é liberada em sucesso, erro e cancelamento',async()=>{
  const gate=new OperationGate();
  const held=deferred();
  const first=gate.run(()=>held.promise,{exclusive:true,holder:'api:query'});
  assert.equal(gate.heldBy('api:query'),true);assert.equal(gate.heldBy('auth:logout'),false);
  await assert.rejects(gate.run(async()=>{},{exclusive:true,holder:'backup:create'}),new RegExp(GATE_BUSY_MESSAGE.replace(/\./g,'\\.')));
  held.resolve();await first;
  assert.equal(gate.isExclusive(),false);
  await assert.rejects(gate.run(async()=>{throw new Error('falha');},{exclusive:true,holder:'x'}),/falha/);
  assert.equal(gate.isExclusive(),false);
  const cancel=Object.assign(new Error('Operação cancelada (cpi_filter).'),{name:'AbortError'});
  await assert.rejects(gate.run(async()=>{throw cancel;},{exclusive:true,holder:'cpi:auto'}),/cancelada/);
  assert.equal(gate.isExclusive(),false);assert.equal(gate.heldBy('cpi:auto'),false);
});

test('E4: chave impede reentrada da mesma ação sem bloquear a exclusiva',async()=>{
  const gate=new OperationGate();const open=deferred();
  const dialog=gate.run(()=>open.promise,{key:'pasta',busyMessage:'A seleção de pasta já está aberta.'});
  await assert.rejects(gate.run(async()=>{},{key:'pasta',busyMessage:'A seleção de pasta já está aberta.'}),/já está aberta/);
  assert.equal(await gate.run(async()=>7,{exclusive:true,holder:'api:query'}),7);
  open.resolve();await dialog;
  assert.equal(await gate.run(async()=>8,{key:'pasta'}),8);
});

test('E4: drenagem aguarda só o segundo plano já aceito, inclusive com falha',async()=>{
  const gate=new OperationGate();const work=deferred();let drained=false;
  const background=gate.run(()=>work.promise,{background:true});
  const shared=gate.run(()=>new Promise(()=>{}));
  const draining=gate.drainBackground().then(()=>{drained=true;});
  await new Promise(r=>setImmediate(r));
  assert.equal(drained,false);
  work.reject(new Error('falha na recuperação'));
  await assert.rejects(background,/falha/);
  await draining;assert.equal(drained,true,'trabalho compartilhado comum não atrasa a drenagem');
  void shared;
});

test('E4: fases do encerramento — único pedido, falha antes do banco reabre, depois do banco mantém bloqueio',()=>{
  const gate=new OperationGate();
  assert.equal(gate.requestShutdown(),true);assert.equal(gate.requestShutdown(),false);
  assert.equal(gate.isShuttingDown(),true);
  assert.throws(()=>gate.assertAccepting(),/encerramento/);
  gate.shutdownFailed(false);
  assert.equal(gate.isShuttingDown(),false);gate.assertAccepting();
  assert.equal(gate.requestShutdown(),true);
  gate.shutdownFailed(true);
  assert.equal(gate.isShuttingDown(),false);
  assert.throws(()=>gate.assertAccepting(),/encerramento/,'banco já em fechamento: continua bloqueado');
  assert.equal(gate.requestShutdown(),true,'nova tentativa de sair é permitida');
  gate.markShutdownReady();
  assert.equal(gate.isShutdownReady(),true);assert.equal(gate.requestShutdown(),false);
});

test('E4: nenhuma flag antiga de concorrência permanece no processo principal',async()=>{
  const source=await readFile(new URL('../src/main/index.ts',import.meta.url),'utf8');
  for(const flag of ['busy','maintenanceActive','sessionTransitionActive','shutdownRequested','shutdownReady','activeCompletions','folderDialogOpen','ApplicationOperations']){
    assert.equal(new RegExp(`\\b${flag}\\b`).test(source),false,flag);
  }
  for(const file of ['backup.ts','maintenance.ts']){
    const text=await readFile(new URL(`../src/main/${file}`,import.meta.url),'utf8');
    assert.equal(/private (creating|cleaning)\b/.test(text),false,file);
  }
});

const CPF='52998224725',OTHER='11144477735';
const empty=(...keys)=>Object.fromEntries(keys.map(key=>[key,{items:[]}]));
const payloadFor=cpf=>({status:{code:4000},data:{basic:{name:'PESSOA FICTÍCIA',cpf,tax_id:{number:cpf}},...empty('phones','addresses','emails','lawsuits')}});

test('E4/C7: recuperação em segundo plano não troca o último PDF aberto pelo usuário',()=>{
  let deps;const opened=[];
  return withMainProcess(async(cpf,onCode)=>{
    const code=cpf===CPF?'Q-AAAAAAAAAA':'Q-BBBBBBBBBB';
    await onCode(code);
    return cpf===CPF?{state:'ready',queryCode:code,payload:payloadFor(CPF)}:{state:'pending',queryCode:code};
  },async({invoke})=>{
    const first=await invoke('api:query',CPF);
    assert.equal(first.state,'ready');
    await writeFile(first.pdf.path,'%PDF-1.4 ficticio');
    const second=await invoke('api:query',OTHER);
    assert.equal(second.state,'pending');
    await deps.complete({id:second.recordId,kind:'person',account:'ipc-tests@example.invalid',cpf:OTHER,queryCode:'Q-BBBBBBBBBB'},payloadFor(OTHER));
    await invoke('report:open-pdf');
    assert.deepEqual(opened,[first.pdf.path]);
  },{onPendingMonitor:value=>{deps=value;},openPath:async path=>{opened.push(path);return '';}});
});

test('E4: recuperação em segundo plano é ignorada durante a limpeza e drenada antes dela',()=>{
  let deps;const entered=deferred(),answer=deferred();const updates=[];
  return withMainProcess(async(_cpf,onCode)=>{await onCode('Q-BBBBBBBBBB');return {state:'pending',queryCode:'Q-BBBBBBBBBB'};},async({invoke,reopenHistory})=>{
    const pending=await invoke('api:query',OTHER);
    const cleaning=invoke('maintenance:clean',{history:false,pdfs:true});
    await entered.promise;
    await deps.complete({id:pending.recordId,kind:'person',account:'ipc-tests@example.invalid',cpf:OTHER,queryCode:'Q-BBBBBBBBBB'},payloadFor(OTHER));
    answer.resolve({response:0});
    assert.equal((await cleaning).cancelled,true);
    const [stored]=await reopenHistory();
    assert.notEqual(stored.status,'ready','a recuperação não rodou durante a limpeza');
    void updates;
  },{onPendingMonitor:value=>{deps=value;},showMessageBox:()=>{entered.resolve();return answer.promise;},
    maintenance:async()=>({deletedRecords:0,deletedPdfs:0,missingPdfs:0})});
});

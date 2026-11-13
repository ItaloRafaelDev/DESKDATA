import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DEV_ONLY_INVOKE, EXCLUSIVE_INVOKE, CPI_STOPPING_INVOKE, IPC_EVENTS, IPC_INVOKE } from '../src/shared/ipc-contract.ts';
import { createBinder } from '../src/main/ipc/bind.ts';
import { OperationGate } from '../src/main/operation-gate.ts';
import { withMainProcess } from './helpers/main-process.mjs';

// E5 — contrato tipado de canais e separação do processo principal. Sem rede, sem Electron real.
const root=new URL('../',import.meta.url);
async function sources(dir){
  const out=[];
  for(const entry of await readdir(new URL(dir,root),{withFileTypes:true})){
    const rel=`${dir}/${entry.name}`;
    if(entry.isDirectory())out.push(...await sources(rel));
    else if(/\.(ts|tsx)$/.test(entry.name))out.push(rel);
  }
  return out;
}
const channels=[...Object.values(IPC_INVOKE),...Object.values(IPC_EVENTS)];
const stripComments=text=>text.replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|[^:])\/\/.*$/gm,'$1');

test('E5: nenhum nome de canal aparece como string literal em src/ fora do contrato',async()=>{
  const found=[];
  for(const file of await sources('src')){
    if(file.endsWith('shared/ipc-contract.ts'))continue;
    const code=stripComments(await readFile(new URL(file,root),'utf8'));
    for(const channel of channels)for(const quote of ["'",'"','`'])if(code.includes(quote+channel+quote))found.push(`${file}: ${channel}`);
  }
  assert.deepEqual(found,[]);
});

test('E5: canais do contrato são únicos e os conjuntos só citam métodos existentes',()=>{
  assert.equal(new Set(channels).size,channels.length);
  for(const set of [EXCLUSIVE_INVOKE,CPI_STOPPING_INVOKE,DEV_ONLY_INVOKE])for(const method of set)assert.ok(Object.hasOwn(IPC_INVOKE,method),method);
  for(const method of CPI_STOPPING_INVOKE)assert.ok(EXCLUSIVE_INVOKE.has(method),method);
});

test('E5: index.ts só compõe os módulos; registro de canais e FULL AUTO ficam fora dele',async()=>{
  const index=await readFile(new URL('src/main/index.ts',root),'utf8');
  assert.doesNotMatch(index,/ipcMain\.handle\(\s*['"`]/);
  assert.doesNotMatch(index,/\bbind\(\s*['"`]/);
  assert.doesNotMatch(index,/executeCpiPersonCycle|classifyPerson|prepareCpiPersonPdf/);
  for(const domain of ['auth','person','pis','company','cpi','maintenance','settings']){
    assert.match(index,new RegExp(`register${domain[0].toUpperCase()+domain.slice(1)}Ipc\\(bind,ctx\\)`),domain);
  }
  assert.match(index,/createCpiScan\(ctx\)/);
  const orchestrator=await readFile(new URL('src/main/cpi/full-auto-orchestrator.ts',root),'utf8');
  assert.match(orchestrator,/executeCpiPersonCycle/);
});

test('E5: preload expõe todos os métodos do contrato, sem literal de canal',async()=>{
  const preload=await readFile(new URL('src/preload/index.ts',root),'utf8');
  assert.match(preload,/Object\.keys\(IPC_INVOKE\)/);
  for(const channel of channels)assert.equal(preload.includes(`'${channel}'`),false,channel);
});

function binderFor(isDev){
  const registered=new Map();
  const bind=createBinder({handle:(channel,listener)=>registered.set(channel,listener),guard:()=>{},gate:new OperationGate(),
    cpiActive:()=>({auto:false,monitor:false}),pauseCpi:async()=>{},write:async()=>{},isDev});
  return {bind,registered};
}

test('E5: binder ignora canais de inspeção da CPI no aplicativo instalado e os registra em DEV',()=>{
  for(const isDev of [false,true]){
    const {bind,registered}=binderFor(isDev);
    for(const method of Object.keys(IPC_INVOKE))bind(method,async()=>undefined);
    for(const method of Object.keys(IPC_INVOKE)){
      const expected=isDev||!DEV_ONLY_INVOKE.has(method);
      assert.equal(registered.has(IPC_INVOKE[method]),expected,`${method} isDev=${isDev}`);
    }
  }
});

test('E5: binder aplica guard e exclusiva com dono igual ao canal',async()=>{
  const gate=new OperationGate();const registered=new Map();let holder;
  const bind=createBinder({handle:(c,l)=>registered.set(c,l),guard:event=>{if(!event.ok)throw new Error('Origem IPC não autorizada.');},gate,
    cpiActive:()=>({auto:false,monitor:false}),pauseCpi:async()=>{},write:async()=>{},isDev:false});
  bind('createBackup',async()=>{holder=gate.heldBy(IPC_INVOKE.createBackup);return {path:'x'};});
  const listener=registered.get(IPC_INVOKE.createBackup);
  await assert.rejects(listener({ok:false}),/Origem IPC não autorizada/);
  await listener({ok:true});
  assert.equal(holder,true);assert.equal(gate.isExclusive(),false);
});

test('E5: processo principal real registra inspeção da CPI só fora do instalador',async()=>{
  for(const isPackaged of [true,false]){
    await withMainProcess(async()=>{throw new Error('não deve consultar');},async({invoke})=>{
      const call=()=>invoke(IPC_INVOKE.cpiInspectPendingRows);
      if(isPackaged)assert.throws(call,/Handler não inicializado/);
      else await call();
      // Canais de produção continuam disponíveis nos dois modos.
      assert.equal(typeof (await invoke(IPC_INVOKE.cpiAutoStatus)),'object');
    },{isPackaged});
  }
});

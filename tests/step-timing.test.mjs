import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStepTimer, NULL_TIMER } from '../src/main/step-timing.ts';
import { DiagnosticLogger } from '../src/main/diagnostics.ts';

const ID='123e4567-e89b-42d3-a456-426614174000';
function recorder(){
  const events=[];let clock=0;
  const timer=(flow='cpi',write=async(event,fields)=>{events.push({event,...fields});})=>
    createStepTimer(flow,write,{now:()=>(clock+=10),id:()=>ID});
  return {events,timer};
}

test('etapa bem-sucedida grava duração, fluxo e id de correlação',async()=>{
  const {events,timer}=recorder();
  const t=timer();
  assert.equal(await t.step('cpi_open_detail',async()=>'ok'),'ok');
  assert.deepEqual(events,[{event:'timing_step',flow:'cpi',correlationId:ID,step:'cpi_open_detail',durationMs:10,state:'success'}]);
  assert.equal(t.correlationId,ID);
});

test('etapa com falha grava failed com o tipo do erro e relança o mesmo erro',async()=>{
  const {events,timer}=recorder();
  const error=new TypeError('CPF 529.982.247-25 recusado');
  await assert.rejects(timer().step('deskdata_query',async()=>{throw error;}),e=>e===error);
  assert.equal(events.length,1);
  assert.equal(events[0].state,'failed');assert.equal(events[0].errorType,'TypeError');
  assert.doesNotMatch(JSON.stringify(events),/529|recusado/);
});

test('begin devolve encerramento idempotente: só o primeiro estado é gravado',()=>{
  const {events,timer}=recorder();
  const end=timer().begin('cpi_attach');
  end('success');end('failed',new Error('x'));
  assert.deepEqual(events.map(e=>e.state),['success']);
});

test('finish grava o ciclo uma única vez com o resultado',()=>{
  const {events,timer}=recorder();
  const t=timer('person');
  t.finish('success','ready');t.finish('failed');
  assert.deepEqual(events,[{event:'timing_cycle',flow:'person',correlationId:ID,durationMs:10,state:'success',outcome:'ready'}]);
});

test('falha ao gravar o diagnóstico nunca interrompe a etapa medida',async()=>{
  const {timer}=recorder();
  const t=timer('cpi',async()=>{throw new Error('disco cheio');});
  assert.equal(await t.step('report_pdf',async()=>42),42);
  t.finish('success','completed');
  const sync=timer('cpi',()=>{throw new Error('falha síncrona');});
  assert.equal(await sync.step('report_pdf',async()=>7),7);
});

test('cada ciclo recebe um id de correlação próprio por padrão',()=>{
  const a=createStepTimer('cpi',async()=>{}),b=createStepTimer('cpi',async()=>{});
  assert.match(a.correlationId,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(a.correlationId,b.correlationId);
});

test('NULL_TIMER executa o trabalho sem gravar nada',async()=>{
  assert.equal(await NULL_TIMER.step('cpi_filter',async()=>3),3);
  NULL_TIMER.begin('cpi_save')('success');NULL_TIMER.finish('success');
});

test('diagnóstico persiste somente campos de tempo válidos e descarta valores livres',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'deskdata-timing-'));
  try{
    const logger=new DiagnosticLogger(dir);
    await logger.write('timing_step',{flow:'cpi',correlationId:ID,step:'cpi_save',durationMs:1234.4,state:'success'});
    await logger.write('timing_cycle',{flow:'cpi',correlationId:ID,durationMs:5,state:'failed',outcome:'verification_required'});
    await logger.write('timing_step',{flow:'52998224725',correlationId:'52998224725',step:'cpf_52998224725',outcome:'529.982.247-25',durationMs:1});
    const [file]=await readdir(dir);
    const rows=(await readFile(join(dir,file),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.deepEqual({...rows[0],at:undefined},{at:undefined,level:'info',event:'timing_step',flow:'cpi',correlationId:ID,step:'cpi_save',durationMs:1234,state:'success'});
    assert.equal(rows[1].outcome,'verification_required');
    assert.deepEqual(Object.keys(rows[2]).sort(),['at','durationMs','event','level']);
    assert.doesNotMatch(JSON.stringify(rows),/529/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

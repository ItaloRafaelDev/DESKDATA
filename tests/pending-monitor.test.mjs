import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingQueryMonitor } from '../src/main/pending-queries.ts';
const target={id:'rec-1',kind:'company',queryCode:'Q-ABC123DEF4',account:'dev@example.com',cnpj:'11222333000181'};
function setup(states){
 const timers=[];const completed=[];const paused=[];let gets=0;
 const scheduler=(fn,ms)=>{const t={fn,ms,cancelled:false};timers.push(t);return {cancel:()=>{t.cancelled=true}}};
 const monitor=new PendingQueryMonitor({
   get:async()=>{gets++;const state=states.shift()??{state:'pending',queryCode:target.queryCode};return state;},
   complete:async(t,result)=>{completed.push({t,result})},
   pause:async(t,reason)=>{paused.push({t,reason})},
   schedule:scheduler,
 });
 const tick=async()=>{const next=timers.find(t=>!t.cancelled);assert.ok(next,'nenhum agendamento');next.cancelled=true;await next.fn()};
 return {monitor,tick,timers,completed,paused,get gets(){return gets}};
}
test('202 sucessivo mantém somente GET e gera PDF uma vez ao receber 200',async()=>{
 const s=setup([{state:'pending',queryCode:target.queryCode},{state:'ready',queryCode:target.queryCode,payload:{data:{}}}]);
 assert.equal(s.monitor.watch(target),true);
 assert.equal(s.monitor.watch(target),false,'deduplicação');
 await s.tick();assert.equal(s.completed.length,0);await s.tick();
 assert.equal(s.completed.length,1);assert.equal(s.gets,2);
 assert.equal(s.monitor.isWatching(target.id),false);
});
test('encerrar sessão cancela agendamentos e ignora resposta GET tardia',async()=>{
 let finish;const finished=[];const timers=[];
 const monitor=new PendingQueryMonitor({get:()=>new Promise(r=>finish=r),complete:async()=>finished.push(1),pause:async()=>{},schedule:(cb)=>{timers.push(cb);return{cancel:()=>{}}}});
 monitor.watch(target);const pending=timers.shift()();monitor.stopAll();finish({state:'ready',queryCode:target.queryCode,payload:{}});await pending;
 assert.equal(finished.length,0);
});
test('falhas consecutivas pausam sem repetir POST',async()=>{
 // O auxiliar injeta erros como retornos; usar monitor com GET que rejeita.
 const timers=[];const errors=[];let count=0;
 const monitor=new PendingQueryMonitor({get:async()=>{count++;throw new Error('HTTP 500');},complete:async()=>assert.fail('Não pode gerar PDF'),pause:async(t,msg)=>errors.push(msg),schedule:(fn)=>{const t={fn,cancelled:false};timers.push(t);return {cancel:()=>t.cancelled=true}}});
 monitor.watch(target);
 for(let i=0;i<3;i++){const next=timers.find(x=>!x.cancelled);next.cancelled=true;await next.fn();}
 assert.equal(errors.length,1);assert.equal(count,3);
 assert.equal(monitor.isWatching(target.id),false);
});
test('40 verificações 202 pausam sem gerar PDF ou loop infinito',async()=>{
 const {monitor,tick,timers,paused,completed}=setup([]);
 monitor.watch(target);
 for(let i=0;i<40;i++)await tick();
 assert.equal(paused.length,1);assert.equal(completed.length,0);
 assert.equal(monitor.isWatching(target.id),false);
 assert.ok(timers.length>=40);
});

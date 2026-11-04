import type { QueryCheck } from './deskdata-client.ts';

export type PendingTarget = {
  id:string; kind:'person'|'company'; account:string; queryCode:string; cpf?:string; cnpj?:string;
};
type Timer={cancel():void};
type Scheduler=(callback:()=>void,delayMs:number)=>Timer;
type PendingDependencies={
  get:(code:string)=>Promise<QueryCheck>;
  complete:(target:PendingTarget,payload:unknown)=>Promise<void>;
  pause:(target:PendingTarget,message:string)=>Promise<void>;
  changed?:()=>void;
  schedule?:Scheduler;
};
type Task={target:PendingTarget;attempts:number;failures:number;timer?:Timer;inFlight:boolean};
const DELAYS=[8_000,12_000,20_000,30_000,45_000,60_000,90_000];
const DEFAULT_SCHEDULER:Scheduler=(callback,ms)=>{
  const handle=setTimeout(callback,ms);
  return {cancel:()=>clearTimeout(handle)};
};

/** Um GET por tentativa, com deduplicação, limite de concorrência e cancelamento por sessão. */
export class PendingQueryMonitor {
  private readonly tasks=new Map<string,Task>();
  private inFlight=0;
  private readonly schedule:Scheduler;
  private readonly deps:PendingDependencies;
  constructor(deps:PendingDependencies){
    this.deps=deps;
    this.schedule=deps.schedule??DEFAULT_SCHEDULER;
  }
  isWatching(id:string):boolean{return this.tasks.has(id);}
  watch(target:PendingTarget,immediate=false):boolean {
    if(this.tasks.has(target.id))return false;
    if(!/^Q-[A-F0-9]{10}$/.test(target.queryCode))throw new Error('Código de recuperação inválido.');
    const task:Task={target,attempts:0,failures:0,inFlight:false};
    this.tasks.set(target.id,task);
    this.arm(task,immediate?0:DELAYS[0]);
    return true;
  }
  stopAll():void{
    for(const task of this.tasks.values())task.timer?.cancel();
    this.tasks.clear();
  }
  private isCurrent(task:Task):boolean{return this.tasks.get(task.target.id)===task;}
  private arm(task:Task,ms:number):void{
    task.timer?.cancel();
    task.timer=this.schedule(()=>this.pollOnce(task.target.id),ms);
  }
  async pollOnce(id:string):Promise<void>{
    const task=this.tasks.get(id);
    if(!task || task.inFlight)return;
    if(this.inFlight>=2){this.arm(task,2_000);return;}
    task.timer=undefined;task.inFlight=true;this.inFlight++;
    try{
      const result=await this.deps.get(task.target.queryCode);
      if(!this.isCurrent(task))return;
      task.failures=0;
      if(result.state==='ready'){
        await this.deps.complete(task.target,result.payload);
        if(!this.isCurrent(task))return;
        this.tasks.delete(id);
        this.deps.changed?.();
        return;
      }
      task.attempts++;
      if(task.attempts>=40){
        await this.pause(task,'Consulta ainda em processamento após várias verificações. Retome a recuperação pelo histórico.');
        return;
      }
      this.arm(task,DELAYS[Math.min(task.attempts,DELAYS.length-1)]);
    }catch(error){
      if(!this.isCurrent(task))return;
      task.failures++;
      const reason=error instanceof Error?error.message:'Erro na recuperação do resultado.';
      // 401, 403 e 404 não devem ser repetidos automaticamente.
      const permanent=/sessão|autenticad|expirad|bloquead|não encontrad|não autorizad|código.*inválido/i.test(reason);
      if(permanent || task.failures>=3){
        await this.pause(task,permanent?'A recuperação exige autenticação ou verificação manual.':'Falhas sucessivas ao recuperar a consulta. Use Retomar GET após verificar a conexão.');
      }else{
        this.arm(task,Math.min(60_000,DELAYS[task.failures]));
      }
    }finally{
      task.inFlight=false;
      this.inFlight--;
    }
  }
  private async pause(task:Task,reason:string):Promise<void>{
    if(!this.isCurrent(task))return;
    try{await this.deps.pause(task.target,reason);}finally{
      if(this.isCurrent(task))this.tasks.delete(task.target.id);
      this.deps.changed?.();
    }
  }
}

/** Registro de trabalhos aceitos e exclusão imediata, sem fila de consultas. */
export class ApplicationOperations {
  private readonly active=new Set<Promise<void>>();
  private exclusive=false;
  private closing=false;

  assertAccepting():void {
    if(this.closing)throw new Error('Aplicativo em encerramento; novas operações estão bloqueadas.');
  }
  isExclusive():boolean {return this.exclusive;}
  stopAccepting():void {this.closing=true;}
  resumeAccepting():void {this.closing=false;}

  async run<T>(work:()=>Promise<T>,exclusive=false):Promise<T>{
    this.assertAccepting();
    if(exclusive && this.exclusive)throw new Error('Outra operação está em andamento. Conclua a operação atual.');
    if(exclusive)this.exclusive=true;
    let finish!:()=>void;
    const completion=new Promise<void>(resolve=>{finish=resolve;});
    this.active.add(completion);
    try{return await work();}
    finally{
      if(exclusive)this.exclusive=false;
      this.active.delete(completion);
      finish();
    }
  }
  async waitForIdle(additional:Promise<unknown>[]=[],timeoutMs=60_000):Promise<boolean>{
    return settleWithin(Promise.allSettled([...this.active,...additional]),timeoutMs);
  }
}

/** O timeout não cancela trabalhos nem autoriza fechar seus recursos. */
export async function settleWithin(work:Promise<unknown>,timeoutMs:number):Promise<boolean>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    return await Promise.race([
      work.then(()=>true),
      new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),Math.max(0,timeoutMs));})
    ]);
  }finally{if(timer)clearTimeout(timer);}
}

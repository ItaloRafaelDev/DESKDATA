/**
 * Prazo por operação (E3). O erro tem nome `TimeoutError` (classe 'timeout' no FULL AUTO) e a mensagem
 * contém apenas o rótulo fixo da etapa: nunca CPF, caminho, URL ou conteúdo de consulta.
 * Um prazo NUNCA autoriza repetir uma operação que pode ter produzido efeito externo (POST, envio CPI).
 */
export class DeadlineError extends Error {
  constructor(label:string,ms:number){
    super(`Tempo limite excedido (${label}, ${Math.max(1,Math.round(ms/1000))} s).`);
    this.name='TimeoutError';
  }
}
export function isDeadlineError(error:unknown):boolean{
  return !!error&&typeof error==='object'&&(error as {name?:unknown}).name==='TimeoutError';
}

/**
 * Corre a operação contra o prazo. No estouro, `onTimeout` roda antes da rejeição (ex.: abortar o
 * `AbortController` da operação para que ela pare no próximo ponto de verificação).
 */
export function withDeadline<T>(work:Promise<T>,ms:number,label:string,onTimeout?:()=>void):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  // A operação abandonada ainda pode terminar ou falhar depois do prazo; esse resultado não é mais usado
  // e não deve virar "unhandled rejection".
  work.catch(()=>undefined);
  const timeout=new Promise<never>((_resolve,reject)=>{
    timer=setTimeout(()=>{
      try{onTimeout?.();}finally{reject(new DeadlineError(label,ms));}
    },Math.max(0,ms));
  });
  return Promise.race([work,timeout]).finally(()=>clearTimeout(timer));
}

/**
 * Executa `body` com um `AbortSignal` próprio, abortado no prazo ou quando `parent` abortar.
 * O corpo deve conferir o sinal (`throwIfAborted`) antes de cada efeito externo.
 */
export function runWithDeadline<T>(label:string,ms:number,body:(signal:AbortSignal)=>Promise<T>,parent?:AbortSignal):Promise<T>{
  const controller=new AbortController();
  let onParentAbort:()=>void=()=>undefined;
  // Cancelamento externo (fechar navegador, logout) encerra a espera na hora, sem aguardar o prazo.
  const cancelled=new Promise<never>((_resolve,reject)=>{
    onParentAbort=():void=>{controller.abort();reject(new CancelledError(label));};
  });
  cancelled.catch(()=>undefined);
  if(parent?.aborted)onParentAbort();else parent?.addEventListener('abort',onParentAbort,{once:true});
  const work=Promise.race([Promise.resolve().then(()=>body(controller.signal)),cancelled]);
  return withDeadline(work,ms,label,()=>controller.abort())
    .finally(()=>parent?.removeEventListener('abort',onParentAbort));
}

/** Erro de cancelamento (pausa, fechamento do navegador, logout); nunca é tratado como sucesso. */
export class CancelledError extends Error {
  constructor(label:string){super(`Operação cancelada (${label}).`);this.name='AbortError';}
}
export function throwIfAborted(signal:AbortSignal|undefined,label:string):void{
  if(signal?.aborted)throw new CancelledError(label);
}

/** Espera cancelável: resolve no prazo ou imediatamente quando o sinal é abortado. */
export function cancellableDelay(ms:number,signal?:AbortSignal):Promise<void>{
  return new Promise(resolve=>{
    if(signal?.aborted){resolve();return;}
    const done=():void=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();};
    const timer=setTimeout(done,Math.max(0,ms));
    signal?.addEventListener('abort',done,{once:true});
  });
}

import type { CpiAutoSnapshot, CpiPendingRowId } from '../../shared/types.ts';
import type { CpiCycleOutcome } from './full-cycle.ts';
import { classifyCpiError, CPI_FAILURE_LABELS, CPI_FAILURE_STREAK_LIMIT, CPI_IMMEDIATE_STOP, type CpiFailureKind } from './failure-classes.ts';
export type { CpiAutoSnapshot } from '../../shared/types.ts';

/** Resultado de uma varredura: no máximo um item processado por ciclo. */
export type CpiScanResult =
  | {kind:'idle';found:number;message?:string}
  | {kind:'item';found:number;outcome:CpiCycleOutcome}
  | {kind:'item_failed';found:number;ids:CpiPendingRowId;failure:CpiFailureKind;message:string};
export interface CpiScanContext {
  /** Abortado por pausa/parada: a varredura não deve iniciar um novo item depois disso. */
  signal:AbortSignal;
  onItem(ids:CpiPendingRowId):void;
}
export interface CpiRunnerOptions {
  sleep?:(ms:number,signal:AbortSignal)=>Promise<void>;
  now?:()=>number;
}

export const CPI_IDLE_FIRST_SECONDS=30;
export const CPI_AFTER_ITEM_SECONDS=2;
export const CPI_DEFAULT_MAX_IDLE_SECONDS=300;

/** Espera cancelável: resolve no prazo ou imediatamente quando o sinal é abortado. */
export function abortableSleep(ms:number,signal:AbortSignal):Promise<void>{
  return new Promise(resolve=>{
    if(signal.aborted){resolve();return;}
    const done=():void=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
    const timer=setTimeout(done,ms);
    signal.addEventListener('abort',done,{once:true});
  });
}
/** Fila vazia: 30 s, 60 s, 120 s... até o teto escolhido (nunca espera ativa). */
export function nextIdleDelaySeconds(previous:number|null,maxSeconds:number):number {
  return Math.min(maxSeconds,previous===null?CPI_IDLE_FIRST_SECONDS:previous*2);
}

/** Diagnostico para a interface sem expor CPF, caminho, token ou detalhes de rede. */
export function safeCpiCycleError(error: unknown): string {
  const original = error instanceof Error ? error.message : '';
  const sanitized = original
    .replace(/https?:\/\/[^\s]+/gi, '[URL]')
    .replace(/\b[A-Za-z]:[\\/][^\s]+/g, '[CAMINHO]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]')
    .replace(/\b\d{3}[.\s-]?\d{3}[.\s-]?\d{3}[-\s]?\d{2}\b/g, '[CPF]')
    .replace(/\b\d{11,}\b/g, '[IDENTIFICADOR]')
    .replace(/\s+/g, ' ').trim().slice(0, 200);
  return sanitized || 'Erro desconhecido; confira os diagnosticos locais.';
}

const initial=():CpiAutoSnapshot=>({phase:'stopped',checks:0,lastMessage:'Aguardando início',nextCheckAt:null,
  intervalSeconds:CPI_DEFAULT_MAX_IDLE_SECONDS,currentItem:null,cycleStartedAt:null,lastCycleMs:null,
  counters:{completed:0,review:0,failures:0,pending:0},failureStreak:null});

/**
 * FULL AUTO contínuo: processa um item por ciclo enquanto houver pesquisas elegíveis; com fila vazia
 * espera com recuo crescente. Para somente por pausa/parada, condição sistêmica (D1) ou
 * 3 falhas consecutivas da mesma classe. Nenhuma falha gera reenvio automático.
 */
export class CpiFullAutoRunner {
  private loop:Promise<void>|null=null;
  private controller:AbortController|null=null;
  private snapshot:CpiAutoSnapshot=initial();
  private readonly scanAndProcess:(context:CpiScanContext)=>Promise<CpiScanResult>;
  private readonly onUpdate:(state:CpiAutoSnapshot)=>void;
  private readonly sleep:(ms:number,signal:AbortSignal)=>Promise<void>;
  private readonly now:()=>number;
  constructor(scanAndProcess:(context:CpiScanContext)=>Promise<CpiScanResult>,
    onUpdate:(state:CpiAutoSnapshot)=>void=()=>{},options:CpiRunnerOptions={}){
    this.scanAndProcess=scanAndProcess;this.onUpdate=onUpdate;
    this.sleep=options.sleep??abortableSleep;this.now=options.now??(()=>Date.now());
  }
  status():CpiAutoSnapshot{return {...this.snapshot,counters:{...this.snapshot.counters},
    currentItem:this.snapshot.currentItem?{...this.snapshot.currentItem}:null,
    failureStreak:this.snapshot.failureStreak?{...this.snapshot.failureStreak}:null};}
  isActive():boolean{return !!this.loop;}
  /** `maxIdleSeconds`: teto da espera com fila vazia (30 a 86400 s). Não limita a quantidade de itens. */
  async start(maxIdleSeconds:number=CPI_DEFAULT_MAX_IDLE_SECONDS):Promise<CpiAutoSnapshot>{
    if(!Number.isSafeInteger(maxIdleSeconds)||maxIdleSeconds<30||maxIdleSeconds>86400)throw new Error('Intervalo CPI deve ser de 30 a 86400 segundos.');
    if(this.isActive())throw new Error('Automação CPI já está em execução.');
    const controller=new AbortController();
    this.controller=controller;
    this.snapshot={...initial(),phase:'running',intervalSeconds:maxIdleSeconds,lastMessage:'Verificando pesquisas pendentes'};
    this.publish({});
    const loop=this.run(controller.signal).finally(()=>{if(this.loop===loop)this.loop=null;});
    this.loop=loop;
    return this.status();
  }
  /** Cancela a espera em curso imediatamente; um item já iniciado termina antes da pausa (sem novo item). */
  async pause():Promise<CpiAutoSnapshot>{
    this.controller?.abort();
    if(this.loop)await this.loop;
    // Uma parada sistêmica (fase 'error') mantém a mensagem que explica a intervenção necessária.
    if(this.snapshot.phase!=='error'){
      this.publish({phase:'paused',nextCheckAt:null,currentItem:null,
        lastMessage:'Pausado pelo usuário; operações já iniciadas foram concluídas'});
    }
    return this.status();
  }
  private publish(update:Partial<CpiAutoSnapshot>):void{
    this.snapshot={...this.snapshot,...update};
    try{this.onUpdate(this.status());}catch{/* A janela pode ter sido fechada entre eventos. */}
  }
  private halt(message:string):void{
    this.controller?.abort();
    this.publish({phase:'error',nextCheckAt:null,currentItem:null,lastMessage:message});
  }
  /** Conta falhas consecutivas por classe; devolve true quando o limite pausa o agente. */
  private countFailure(kind:CpiFailureKind):boolean{
    const streak=this.snapshot.failureStreak;
    const count=streak?.kind===kind?streak.count+1:1;
    const counters={...this.snapshot.counters,failures:this.snapshot.counters.failures+1};
    this.publish({failureStreak:{kind,count},counters});
    return count>=CPI_FAILURE_STREAK_LIMIT;
  }
  private async run(signal:AbortSignal):Promise<void>{
    let idleDelay:number|null=null;
    // Condição de parada: `signal.aborted` (pausa, parada ou halt sistêmico). Cada volta faz uma
    // varredura e, se continuar, uma espera cancelável de pelo menos 2 s; não há espera ativa.
    while(!signal.aborted){
      const startedAt=this.now();
      this.publish({phase:'running',nextCheckAt:null,currentItem:null,cycleStartedAt:new Date(startedAt).toISOString()});
      let delaySeconds:number;
      try{
        const result=await this.scanAndProcess({signal,onItem:ids=>this.publish({currentItem:{...ids}})});
        const checks=this.snapshot.checks+1,lastCycleMs=Math.max(0,Math.round(this.now()-startedAt));
        if(result.kind==='idle'){
          idleDelay=nextIdleDelaySeconds(idleDelay,this.snapshot.intervalSeconds);delaySeconds=idleDelay;
          this.publish({checks,lastCycleMs,failureStreak:null,
            lastMessage:result.message??(result.found===0?'Nenhuma pesquisa 29 pendente':'Nenhuma pesquisa elegível agora; itens em revisão ou aguardando a Deskdata')});
        }else if(result.kind==='item_failed'){
          idleDelay=null;delaySeconds=CPI_AFTER_ITEM_SECONDS;
          const counters={...this.snapshot.counters,review:this.snapshot.counters.review+1};
          this.publish({checks,lastCycleMs,counters,
            lastMessage:`Pesquisa ${result.ids.pesquisaId} enviada para revisão (${CPI_FAILURE_LABELS[result.failure]}): ${result.message.replace(/[.\s]+$/,'')}. O agente segue para a próxima.`});
          if(this.countFailure(result.failure)){this.halt(this.streakMessage(result.failure));return;}
        }else{
          idleDelay=null;
          const outcome=result.outcome,c=this.snapshot.counters;
          const counters={...c,
            completed:c.completed+(outcome.state==='completed'?1:0),
            review:c.review+(outcome.state==='review_required'||outcome.state==='verification_required'?1:0),
            pending:c.pending+(outcome.state==='pending'?1:0)};
          // Item adiado (Deskdata em processamento) não deve acelerar a varredura da mesma listagem.
          delaySeconds=outcome.state==='pending'?CPI_IDLE_FIRST_SECONDS:CPI_AFTER_ITEM_SECONDS;
          this.publish({checks,lastCycleMs,counters,lastMessage:outcome.warning==='auxiliary_404'
            ?'CPI respondeu e anexou PDF, mas houve erro 404 em recurso auxiliar. Verifique a integracao externa.'
            :`Pesquisa ${outcome.pesquisaId}: ${outcome.message}`});
          if(outcome.state==='verification_required'){
            if(this.countFailure('submit_unverified')){this.halt(this.streakMessage('submit_unverified'));return;}
          }else this.publish({failureStreak:null});
        }
      }catch(error){
        const kind=classifyCpiError(error);
        const lastCycleMs=Math.max(0,Math.round(this.now()-startedAt));
        this.publish({checks:this.snapshot.checks+1,lastCycleMs});
        const detail=safeCpiCycleError(error).replace(/[.\s]+$/,'');
        if(CPI_IMMEDIATE_STOP.has(kind)){
          this.countFailure(kind);
          this.halt(`Falha CPI (${CPI_FAILURE_LABELS[kind]}): ${detail}. Automacao pausada sem reenvio automatico.`);return;
        }
        if(this.countFailure(kind)){this.halt(this.streakMessage(kind,detail));return;}
        idleDelay=nextIdleDelaySeconds(idleDelay,this.snapshot.intervalSeconds);delaySeconds=idleDelay;
        this.publish({lastMessage:`Falha CPI (${CPI_FAILURE_LABELS[kind]}): ${detail}. Nova tentativa de leitura da listagem, sem reenvio.`});
      }
      if(signal.aborted)break;
      this.publish({phase:'waiting',currentItem:null,nextCheckAt:new Date(this.now()+delaySeconds*1000).toISOString()});
      await this.sleep(delaySeconds*1000,signal);
    }
  }
  private streakMessage(kind:CpiFailureKind,detail?:string):string{
    return `${CPI_FAILURE_STREAK_LIMIT} falhas consecutivas: ${CPI_FAILURE_LABELS[kind]}${detail?` (${detail})`:''}. Automacao pausada sem reenvio automatico.`;
  }
}

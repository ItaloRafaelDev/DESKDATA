import type { CpiCycleOutcome } from './full-cycle.ts';

export interface CpiAutoSnapshot {
  phase:'stopped'|'running'|'waiting'|'paused'|'error';
  checks:number;
  processed:number;
  lastMessage:string;
  nextCheckAt:string|null;
  intervalSeconds:number;
}
/** Após uma conclusão, processar a próxima solicitação sem aguardar o ciclo de monitoramento. */
export function nextFullAutoDelaySeconds(intervalSeconds:number,found:number,outcomes:CpiCycleOutcome[]):number {
  const completed=outcomes.filter(item=>item.state==='completed').length;
  return completed>0 && found>completed ? 2 : intervalSeconds;
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

export class CpiFullAutoRunner {
  private current:Promise<void>|null=null;
  private timer:ReturnType<typeof setTimeout>|null=null;
  private shouldRun=false;
  private snapshot:CpiAutoSnapshot={phase:'stopped',checks:0,processed:0,lastMessage:'Aguardando início',nextCheckAt:null,intervalSeconds:60};
  private readonly scanAndProcess:()=>Promise<{found:number; outcomes:CpiCycleOutcome[]}>;
  private readonly onUpdate:(state:CpiAutoSnapshot)=>void;
  constructor(scanAndProcess:()=>Promise<{found:number; outcomes:CpiCycleOutcome[]}>,
    onUpdate:(state:CpiAutoSnapshot)=>void=()=>{}){this.scanAndProcess=scanAndProcess;this.onUpdate=onUpdate;}
  status():CpiAutoSnapshot{return {...this.snapshot};}
  isActive():boolean{return this.shouldRun || !!this.current;}
  async start(seconds:number):Promise<CpiAutoSnapshot>{
    if(!Number.isSafeInteger(seconds)||seconds<30||seconds>86400)throw new Error('Intervalo CPI deve ser de 30 a 86400 segundos.');
    if(this.isActive())throw new Error('Automação CPI já está em execução.');
    this.shouldRun=true;
    this.publish({phase:'running',intervalSeconds:seconds,nextCheckAt:null,lastMessage:'Verificando pesquisas pendentes'});
    void this.cycle();
    return this.status();
  }
  async pause():Promise<CpiAutoSnapshot>{
    this.shouldRun=false;
    if(this.timer){clearTimeout(this.timer);this.timer=null;}
    if(this.current)await this.current.catch(()=>{});
    this.publish({phase:'paused',nextCheckAt:null,lastMessage:'Pausado pelo usuário; operações já iniciadas foram concluídas'});
    return this.status();
  }
  private publish(update:Partial<CpiAutoSnapshot>):void {this.snapshot={...this.snapshot,...update};this.onUpdate(this.status());}
  private async cycle():Promise<void>{
    if(!this.shouldRun)return;
    let cycleResult:{found:number;outcomes:CpiCycleOutcome[]}|null=null;
    const promise=this.scanAndProcess().then(result=>{
      cycleResult=result;
      const completed=result.outcomes.filter(item=>item.state==='completed').length;
      const halted=result.outcomes.find(item=>item.state==='verification_required'||item.state==='review_required');
      const warned=result.outcomes.find(item=>item.warning==='auxiliary_404');
      this.publish({checks:this.snapshot.checks+1,processed:this.snapshot.processed+completed,
        lastMessage:halted ? 'Solicitação exige verificação manual; automação pausada' :
          warned ? 'CPI respondeu e anexou PDF, mas houve erro 404 em recurso auxiliar. Verifique a integracao externa.' :
          result.found===0 ? 'Nenhuma pesquisa 29 pendente' : `${result.outcomes.length} pesquisa(s) processada(s) neste ciclo`});
      if(halted)this.shouldRun=false;
    });
    this.current=promise;
    try{await promise;}
    catch(error){
      this.shouldRun=false;
      this.publish({phase:'error',nextCheckAt:null,
        lastMessage:`Falha CPI: ${safeCpiCycleError(error)}. Automacao pausada sem reenvio automatico.`});
      return;
    } finally{this.current=null;}
    if(!this.shouldRun){this.publish({phase:'paused',nextCheckAt:null});return;}
    const completedCycle=cycleResult as {found:number;outcomes:CpiCycleOutcome[]}|null;
    const delaySeconds=completedCycle
      ? nextFullAutoDelaySeconds(this.snapshot.intervalSeconds,completedCycle.found,completedCycle.outcomes)
      : this.snapshot.intervalSeconds;
    const next=new Date(Date.now()+delaySeconds*1000).toISOString();
    this.publish({phase:'waiting',nextCheckAt:next});
    this.timer=setTimeout(()=>{
      this.timer=null;
      this.publish({phase:'running',nextCheckAt:null});
      void this.cycle();
    },delaySeconds*1000);
  }
}

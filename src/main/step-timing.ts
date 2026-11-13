import { randomUUID } from 'node:crypto';

/** Somente nomes fixos chegam ao diagnóstico: nenhum CPF, CNPJ, nome, caminho ou código de consulta. */
export const TIMED_FLOWS=['cpi','person','pis','company'] as const;
export const TIMED_STEPS=[
  'cpi_filter','cpi_rows','cpi_select','cpi_open_detail','cpi_read_cpf','cpi_fill','cpi_attach','cpi_save','cpi_close_detail','cpi_close_unsaved',
  'deskdata_credits','deskdata_query','deskdata_fetch','report_pdf'
] as const;
export const TIMED_OUTCOMES=['completed','verification_required','review_required','not_submitted','pending','ready','no_pis','empty','idle','item_failed'] as const;
export type TimedFlow=typeof TIMED_FLOWS[number];
export type TimedStep=typeof TIMED_STEPS[number];
export type TimedOutcome=typeof TIMED_OUTCOMES[number];
export type TimedState='success'|'failed';
export type EndStep=(state:TimedState,error?:unknown)=>void;
export type DiagnosticWrite=(event:string,fields:Record<string,unknown>)=>Promise<void>|void;

export interface StepTimer {
  readonly correlationId:string;
  /** Inicia uma etapa; o encerramento é idempotente (só o primeiro estado é gravado). */
  begin(step:TimedStep):EndStep;
  step<T>(step:TimedStep,work:()=>Promise<T>):Promise<T>;
  /** Encerra o ciclo uma única vez. */
  finish(state:TimedState,outcome?:TimedOutcome,error?:unknown):void;
}

function errorType(error:unknown):string|undefined {return error instanceof Error?error.name:undefined;}

/** Mede etapas de um ciclo com um id de correlação próprio. Falhas de gravação nunca afetam o ciclo. */
export function createStepTimer(flow:TimedFlow,write:DiagnosticWrite,options:{now?:()=>number;id?:()=>string}={}):StepTimer{
  const now=options.now??(()=>performance.now());
  const correlationId=(options.id??randomUUID)();
  const started=now();
  let finished=false;
  const emit=(event:string,fields:Record<string,unknown>):void=>{
    try{void Promise.resolve(write(event,{flow,correlationId,...fields})).catch(()=>{});}catch{/* diagnóstico é opcional */}
  };
  const begin=(step:TimedStep):EndStep=>{
    const at=now();let ended=false;
    return (state,error)=>{
      if(ended)return;ended=true;
      const type=state==='failed'?errorType(error):undefined;
      emit('timing_step',{step,durationMs:now()-at,state,...(type?{errorType:type}:{})});
    };
  };
  return {
    correlationId,begin,
    async step(step,work){
      const end=begin(step);
      try{const result=await work();end('success');return result;}
      catch(error){end('failed',error);throw error;}
    },
    finish(state,outcome,error){
      if(finished)return;finished=true;
      const type=state==='failed'?errorType(error):undefined;
      emit('timing_cycle',{durationMs:now()-started,state,...(outcome?{outcome}:{}),...(type?{errorType:type}:{})});
    }
  };
}

const NULL_END:EndStep=()=>{};
/** Medição desligada: executa o trabalho sem gravar nada. */
export const NULL_TIMER:StepTimer={correlationId:'',begin:()=>NULL_END,step:(_step,work)=>work(),finish:()=>{}};

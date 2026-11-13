import type { CpiPendingRowId } from './pending-rows.ts';
import type { CpiWorkStage } from './workflow-store.ts';

/**
 * Estágios que o FULL AUTO nunca reabre: concluído, revisão/verificação manual e envio já iniciado
 * (o resultado remoto pode ter sido aceito). A proteção vem do workflow-store cifrado e vale após reinício.
 */
export const CPI_FINAL_STAGES:ReadonlySet<CpiWorkStage>=new Set<CpiWorkStage>(['completed','review_required','verification_required','submit_started']);
export const CPI_DEFER_FIRST_MS=60_000;
export const CPI_DEFER_MAX_MS=600_000;

const rowKey=(ids:CpiPendingRowId):string=>`${ids.pesquisaId}:${ids.solicitacaoId}`;

export interface CpiSelection {ids?:CpiPendingRowId; finalCount:number; deferredCount:number}

/**
 * Escolhe o primeiro item elegível da listagem. Itens com consulta Deskdata ainda em processamento
 * (HTTP 202) são adiados em memória (60 s, dobrando até 10 min) para não reabrir o mesmo detalhe a cada ciclo.
 */
export class CpiQueueSelector {
  private readonly deferred=new Map<string,{until:number;delayMs:number}>();
  private readonly now:()=>number;
  constructor(now:()=>number=()=>Date.now()){this.now=now;}
  select(rows:readonly CpiPendingRowId[],stages:readonly (CpiWorkStage|undefined)[]):CpiSelection {
    const at=this.now();let finalCount=0,deferredCount=0;
    for(const [index,ids] of rows.entries()){
      const stage=stages[index];
      if(stage&&CPI_FINAL_STAGES.has(stage)){finalCount++;continue;}
      if((this.deferred.get(rowKey(ids))?.until??0)>at){deferredCount++;continue;}
      return {ids,finalCount,deferredCount};
    }
    return {finalCount,deferredCount};
  }
  defer(ids:CpiPendingRowId):void {
    const previous=this.deferred.get(rowKey(ids));
    const delayMs=previous?Math.min(previous.delayMs*2,CPI_DEFER_MAX_MS):CPI_DEFER_FIRST_MS;
    this.deferred.set(rowKey(ids),{until:this.now()+delayMs,delayMs});
  }
  release(ids:CpiPendingRowId):void {this.deferred.delete(rowKey(ids));}
  reset():void {this.deferred.clear();}
  get deferredSize():number {return this.deferred.size;}
}

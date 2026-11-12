import type { CpiPendingRowId } from './pending-rows.ts';
import type { CpiWorkItem, CpiWorkflowStore } from './workflow-store.ts';

export interface CpiReconciliationServices {
  store:CpiWorkflowStore;
  account:string;
  ids:CpiPendingRowId;
  /** Confere o histórico e o PDF da conta sem emitir consulta Deskdata. */
  checkLocal(job:CpiWorkItem):Promise<{ready:boolean;cpf?:string}>;
  /** Lê somente o detalhe já aberto pelo operador; nenhum POST ou navegação. */
  inspectRemote(ids:CpiPendingRowId,classification:'restrictions'|'information',cpf:string):Promise<'confirmed'|'unverified'|'unavailable'>;
}

/** Nunca aceita estágio ou evidência do renderer; a conclusão depende das duas fronteiras verificadas. */
export async function reconcileCpiWorkflow(s:CpiReconciliationServices):Promise<CpiWorkItem>{
  const job=await s.store.get(s.account,s.ids);
  if(!job||!['review_required','verification_required','submit_started'].includes(job.stage))throw new Error('Pesquisa CPI não está pendente de verificação.');
  if(!job.historyRecordId||!job.classification)return s.store.recordVerification(s.account,s.ids,'local_incomplete');
  const local=await s.checkLocal(job);
  if(!local.ready||!local.cpf)return s.store.recordVerification(s.account,s.ids,'local_incomplete');
  let remote:'confirmed'|'unverified'|'unavailable';
  try{remote=await s.inspectRemote(s.ids,job.classification,local.cpf);}
  catch{remote='unavailable';}
  return s.store.recordVerification(s.account,s.ids,
    remote==='confirmed'?'confirmed':remote==='unverified'?'remote_unverified':'remote_unavailable');
}

import {normalizePisResult, PisNotAvailableError, type PisRecord} from '../shared/pis-report.ts';
import type {PisQueryExecution, QueryOutcome} from '../shared/types.ts';

/** Distingue resultado cadastral sem PIS de erro operacional, sem criar um PDF vazio. */
export async function resolvePisOutcome(options:{
  cpf:string;
  payload:unknown;
  recordId:string;
  queryCode?:string;
  save:(record:PisRecord)=>Promise<QueryOutcome>;
  markUnavailable:()=>Promise<void>;
}):Promise<PisQueryExecution> {
  let record:PisRecord;
  try {record=normalizePisResult(options.payload,options.cpf);}
  catch(error){
    if(!(error instanceof PisNotAvailableError))throw error;
    await options.markUnavailable();
    return {state:'no_pis',recordId:options.recordId,queryCode:options.queryCode};
  }
  const pdf=await options.save(record);
  return {state:'ready',pdf:{...pdf,recordId:options.recordId}};
}

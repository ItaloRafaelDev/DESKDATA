import { isValidCpf } from '../../shared/cpf.ts';
import { normalizeDeskdataResponse } from '../../shared/normalizer.ts';
import { assertRecoveredCpf } from '../../shared/query-identity.ts';
import type { NormalizedData } from '../../shared/types.ts';
import type { QueryRecord } from '../query-history.ts';
import { classifyCpiPerson } from './person-rules.ts';
import type { CpiPendingRowId } from './pending-rows.ts';
import { findCpiPersonPdf } from './person-pdf.ts';
import type { CpiWorkItem, CpiWorkStage } from './workflow-store.ts';

export type CpiCycleOutcome = {state:'completed'|'verification_required'|'pending'|'review_required'; pesquisaId:string;solicitacaoId:string;message:string;warning?:'auxiliary_404'};
export interface FullCycleServices {
  account:string;
  ids:CpiPendingRowId;
  outputFolder:string;
  getCpf():Promise<string>;
  getJob():Promise<CpiWorkItem|null>;
  claim():Promise<CpiWorkItem>;
  mark(stage:CpiWorkStage, updates?:Pick<CpiWorkItem,'historyRecordId'|'classification'>):Promise<CpiWorkItem>;
  findLatest(cpf:string):Promise<QueryRecord|null>;
  beginHistory(cpf:string):Promise<QueryRecord>;
  setQueryCode(recordId:string,code:string):Promise<void>;
  getCredits():Promise<number>;
  verifyPaidBalance(credits:number):Promise<void>;
  paidApproved():Promise<boolean>;
  submitCpf(cpf:string,callback:(code:string)=>Promise<void>):Promise<{state:'pending';queryCode:string}|{state:'ready';queryCode?:string;payload:unknown}>;
  fetchByCode(code:string):Promise<{payload:unknown;queryCode:string}>;
  savePdf(cpf:string,recordId:string,queryCode:string|undefined,data:NormalizedData):Promise<void>;
  uploadAndSave(pdfPath:string,classification:'restrictions'|'information'):Promise<'confirmed'|'confirmed_auxiliary_404'|'unverified'>;
  closeCompletedDetail():Promise<void>;
}
function outcome(args:FullCycleServices,state:CpiCycleOutcome['state'],message:string,warning?:CpiCycleOutcome['warning']):CpiCycleOutcome {
  return {...args.ids,state,message,...(warning?{warning}:{})};
}
/**
 * Uma solicitação por execução. Nenhum POST será repetido caso uma resposta seja incerta.
 * A memória do histórico e o registro CPI são conferidos antes de cada efeito externo.
 */
export async function executeCpiPersonCycle(s:FullCycleServices):Promise<CpiCycleOutcome>{
  if(!s.outputFolder)throw new Error('Configure a pasta de PDFs antes de iniciar a automação.');
  const cpf=await s.getCpf();
  if(!isValidCpf(cpf))throw new Error('CPF do detalhe CPI inválido.');
  let job=await s.getJob();
  if(!job)job=await s.claim();
  if(['completed','submit_started','verification_required','review_required'].includes(job.stage)){
    return outcome(s,job.stage==='completed'?'completed':'review_required',
      'Esta solicitação já foi processada ou requer verificação manual; nenhum envio repetido.');
  }
  const latest=await s.findLatest(cpf);
  let record=latest;
  let payload:unknown;
  let queryCode=record?.queryCode;
  if(!record){
    if(job.historyRecordId || job.stage==='query_started'){
      await s.mark('review_required');
      return outcome(s,'review_required','Há tentativa anterior sem histórico recuperável. Não repetir POST.');
    }
    if(!await s.paidApproved())return outcome(s,'review_required','Autorização Deskdata necessária para nova consulta.');
    const credits=await s.getCredits();
    // O saldo e a aprovação são conferidos antes de criar o histórico e enviar POST.
    // O próprio status query_started impede repetir o POST se a rede falhar.
    await s.verifyPaidBalance(credits);
    record=await s.beginHistory(cpf);
    await s.mark('query_started',{historyRecordId:record.id});
    const started=await s.submitCpf(cpf,code=>s.setQueryCode(record!.id,code));
    queryCode=started.queryCode;
    if(started.state==='pending'){
      await s.mark('query_pending',{historyRecordId:record.id});
      return outcome(s,'pending','Consulta Deskdata em processamento; será recuperada por GET, sem novo POST.');
    }
    payload=started.payload;
  }else{
    if(record.account!==s.account||record.cpf!==cpf||(record.kind!==undefined&&record.kind!=='person')){
      throw new Error('Histórico não corresponde à identidade e à conta da CPI.');
    }
    if(job.historyRecordId && job.historyRecordId!==record.id){
      await s.mark('review_required');
      return outcome(s,'review_required','Vínculo com o histórico mudou; verificação manual necessária.');
    }
    if(!queryCode){
      await s.mark('review_required',{historyRecordId:record.id});
      return outcome(s,'review_required','Consulta existente sem código GET; não é possível confirmar competência dos processos.');
    }
    await s.mark('query_pending',{historyRecordId:record.id});
    const received=await s.fetchByCode(queryCode);
    payload=received.payload;
  }
  assertRecoveredCpf(payload,cpf);
  const data=normalizeDeskdataResponse(payload);
  const classification=classifyCpiPerson(data);
  if(classification.state!=='classified'){
    await s.mark('review_required',{historyRecordId:record.id});
    return outcome(s,'review_required','Processos incompletos ou competência não identificável; envio CPI bloqueado.');
  }
  if(record.status!=='ready'){
    await s.savePdf(cpf,record.id,queryCode,data);
  }else{
    try{await findCpiPersonPdf(record,cpf,s.outputFolder);}
    catch{await s.savePdf(cpf,record.id,queryCode,data);}
  }
  // Recarregar o histórico após gerar um PDF: não confiar em referência desatualizada.
  const updated=await s.findLatest(cpf);
  if(!updated||updated.id!==record.id)throw new Error('Histórico mudou durante geração do PDF.');
  const pdf=await findCpiPersonPdf(updated,cpf,s.outputFolder);
  await s.mark('pdf_ready',{historyRecordId:record.id,classification:classification.result});
  // Sem retry após esta marcação: eventual timeout ou queda pode significar envio já aceito.
  await s.mark('submit_started');
  const confirmation=await s.uploadAndSave(pdf,classification.result);
  if(confirmation==='confirmed'||confirmation==='confirmed_auxiliary_404'){
    await s.mark('completed');
    try {
      await s.closeCompletedDetail();
    } catch {
      // A resposta já está concluída no histórico local. Não reenviar; aguardar fechamento manual.
      return outcome(s,'review_required','Resposta salva, mas o fechamento ou a atualização da listagem CPI não foi confirmado. Verificação manual necessária; não reenviar.');
    }
    if(confirmation==='confirmed_auxiliary_404')return outcome(s,'completed',
      'Resposta CPI confirmada e janela fechada; erro 404 do recurso auxiliar cpi_api_request.aspx observado. Verificar a integracao externa.',
      'auxiliary_404');
    return outcome(s,'completed','Resposta CPI confirmada, modal fechado e próxima solicitação liberada.');
  }
  await s.mark('verification_required');
  return outcome(s,'verification_required','Envio efetuado sem confirmação suficiente; verificar manualmente, sem reenvio.');
}

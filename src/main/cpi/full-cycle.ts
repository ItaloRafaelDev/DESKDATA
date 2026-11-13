import { isValidCpf } from '../../shared/cpf.ts';
import { DataContractError, normalizeDeskdataResponse } from '../../shared/normalizer.ts';
import type { JudicialIssueCode } from '../../shared/judicial.ts';
import { assertRecoveredCpf } from '../../shared/query-identity.ts';
import type { NormalizedData } from '../../shared/types.ts';
import type { QueryRecord } from '../query-history.ts';
import { assessCpiPerson } from './person-rules.ts';
import type { CpiPendingRowId } from './pending-rows.ts';
import { findCpiPersonPdf } from './person-pdf.ts';
import type { CpiWorkItem, CpiWorkStage } from './workflow-store.ts';
import { NULL_TIMER, type StepTimer } from '../step-timing.ts';

/** `not_submitted`: falha antes do clique em "Alterar"; item fica em `pdf_ready`, reprocessável com o mesmo PDF e sem POST. */
export type CpiCycleOutcome = {state:'completed'|'verification_required'|'pending'|'review_required'|'not_submitted'; pesquisaId:string;solicitacaoId:string;message:string;warning?:'auxiliary_404';reviewReason?:JudicialIssueCode};
export type CpiSaveOutcome = 'confirmed'|'confirmed_auxiliary_404'|'unverified'|'not_submitted'|'not_submitted_postback';
export interface FullCycleServices {
  account:string;
  ids:CpiPendingRowId;
  outputFolder:string;
  getCpf():Promise<string>;
  getJob():Promise<CpiWorkItem|null>;
  claim():Promise<CpiWorkItem>;
  mark(stage:CpiWorkStage, updates?:Pick<CpiWorkItem,'historyRecordId'|'classification'|'reviewReason'>):Promise<CpiWorkItem>;
  findLatest(cpf:string):Promise<QueryRecord|null>;
  beginHistory(cpf:string):Promise<QueryRecord>;
  setQueryCode(recordId:string,code:string):Promise<void>;
  getCredits():Promise<number>;
  verifyPaidBalance(credits:number):Promise<void>;
  paidApproved():Promise<boolean>;
  submitCpf(cpf:string,callback:(code:string)=>Promise<void>):Promise<{state:'pending';queryCode:string}|{state:'ready';queryCode?:string;payload:unknown}>;
  /** Um único GET por ciclo (sem polling): 202 devolve 'pending' e o item é retomado depois, sem novo POST. */
  checkByCode(code:string):Promise<{state:'pending';queryCode:string}|{state:'ready';queryCode:string;payload:unknown}>;
  /** Grava o PDF CPI (CPI_<pesquisaId>_<solicitacaoId>_<data>.pdf) e o registra na consulta. */
  savePdf(cpf:string,recordId:string,queryCode:string|undefined,data:NormalizedData):Promise<void>;
  /** `beforeSubmit` grava `submit_started` imediatamente antes do clique em "Alterar"; sem ele gravado, não há clique. */
  uploadAndSave(pdfPath:string,classification:'restrictions'|'information',beforeSubmit:()=>Promise<void>):Promise<CpiSaveOutcome>;
  closeCompletedDetail():Promise<void>;
  /** Fecha o modal sem salvar (falha antes do clique). */
  closeUnsavedDetail():Promise<void>;
  /** Medição de duração por etapa; recebe apenas nomes fixos de etapa. */
  timer?:Pick<StepTimer,'step'>;
}
function outcome(args:FullCycleServices,state:CpiCycleOutcome['state'],message:string,warning?:CpiCycleOutcome['warning'],reviewReason?:JudicialIssueCode):CpiCycleOutcome {
  return {...args.ids,state,message,...(warning?{warning}:{}),...(reviewReason?{reviewReason}:{})};
}
/**
 * Uma solicitação por execução. Nenhum POST será repetido caso uma resposta seja incerta.
 * A memória do histórico e o registro CPI são conferidos antes de cada efeito externo.
 */
export async function executeCpiPersonCycle(s:FullCycleServices):Promise<CpiCycleOutcome>{
  if(!s.outputFolder)throw new Error('Configure a pasta de PDFs antes de iniciar a automação.');
  const timer=s.timer??NULL_TIMER;
  let job=await s.getJob();
  if(job&&['completed','submit_started','verification_required','review_required'].includes(job.stage)){
    return outcome(s,job.stage==='completed'?'completed':'review_required',
      'Esta solicitação já foi processada ou requer verificação manual; nenhum envio repetido.',undefined,job.reviewReason);
  }
  const cpf=await s.getCpf();
  if(!isValidCpf(cpf))throw new Error('CPF do detalhe CPI inválido.');
  if(!job)job=await s.claim();
  const latest=await s.findLatest(cpf);
  // Reprocessamento após falha antes do clique: o PDF e a classificação de `pdf_ready` são reaproveitados,
  // sem nova consulta (nem POST nem GET) e sem regerar o PDF. Sem PDF válido, segue o caminho normal (GET).
  if(job.stage==='pdf_ready'&&job.classification&&latest&&job.historyRecordId===latest.id&&
    latest.account===s.account&&latest.cpf===cpf&&(latest.kind===undefined||latest.kind==='person')){
    const reused=await findCpiPersonPdf(latest,cpf,s.outputFolder,s.ids).catch(()=>null);
    if(reused)return submit(s,reused,job.classification);
  }
  let record=latest;
  let payload:unknown;
  let queryCode=record?.queryCode;
  if(!record){
    if(job.historyRecordId || job.stage==='query_started'){
      await s.mark('review_required');
      return outcome(s,'review_required','Há tentativa anterior sem histórico recuperável. Não repetir POST.');
    }
    // Condição sistêmica (D1): sem autorização nenhuma pesquisa nova avança; o agente pausa sem marcar o item.
    if(!await s.paidApproved())throw new Error('Autorize novas consultas Deskdata para esta conta em Minha conta.');
    // O saldo e a aprovação são conferidos antes de criar o histórico e enviar POST.
    // O próprio status query_started impede repetir o POST se a rede falhar.
    await timer.step('deskdata_credits',async()=>s.verifyPaidBalance(await s.getCredits()));
    record=await s.beginHistory(cpf);
    await s.mark('query_started',{historyRecordId:record.id});
    const created=record;
    const started=await timer.step('deskdata_query',()=>s.submitCpf(cpf,code=>s.setQueryCode(created.id,code)));
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
    const code=queryCode;
    const received=await timer.step('deskdata_fetch',()=>s.checkByCode(code));
    if(received.state==='pending')return outcome(s,'pending','Consulta Deskdata ainda em processamento; será retomada por GET, sem novo POST.');
    payload=received.payload;
  }
  assertRecoveredCpf(payload,cpf);
  let data:NormalizedData;
  try{data=normalizeDeskdataResponse(payload);}
  catch(error){
    if(!(error instanceof DataContractError)||!error.issue)throw error;
    await s.mark('review_required',{historyRecordId:record.id,reviewReason:error.issue.code});
    return outcome(s,'review_required','Integridade judicial não confirmada; PDF e envio CPI bloqueados.',undefined,error.issue.code);
  }
  const assessment=assessCpiPerson(data);
  const classification=assessment.classification;
  if(classification.state!=='classified'){
    const reviewReason=assessment.issues[0].code;
    await s.mark('review_required',{historyRecordId:record.id,reviewReason});
    return outcome(s,'review_required','Processos incompletos ou competência não identificável; envio CPI bloqueado.',undefined,reviewReason);
  }
  // Um PDF ready pode ter sido emitido de outra versão da resposta. A assinatura
  // e o vínculo CPF/registro não comprovam quais processos ele contém.
  const previousPdfPaths=new Set(record.pdfPaths);
  const recordId=record.id;
  await timer.step('report_pdf',()=>s.savePdf(cpf,recordId,queryCode,data));
  // Recarregar o histórico após gerar um PDF: não confiar em referência desatualizada.
  const updated=await s.findLatest(cpf);
  if(!updated||updated.id!==record.id)throw new Error('Histórico mudou durante geração do PDF.');
  const currentPdfPaths=updated.pdfPaths.filter(path=>!previousPdfPaths.has(path));
  // Nunca voltar silenciosamente ao PDF legado se a geração atual não foi vinculada.
  const pdf=await findCpiPersonPdf({...updated,pdfPaths:currentPdfPaths},cpf,s.outputFolder,s.ids);
  await s.mark('pdf_ready',{historyRecordId:record.id,classification:classification.result});
  return submit(s,pdf,classification.result);
}
/**
 * Anexar → conferir o input → `submit_started` → "Alterar" → confirmação → modal fechado → item fora da listagem
 * → `completed`. O checkpoint é gravado pelo adaptador logo antes do clique: sem retry depois dele.
 */
async function submit(s:FullCycleServices,pdf:string,classification:'restrictions'|'information'):Promise<CpiCycleOutcome>{
  const timer=s.timer??NULL_TIMER;
  let checkpoint=false;
  let confirmation:CpiSaveOutcome;
  try{confirmation=await s.uploadAndSave(pdf,classification,async()=>{await s.mark('submit_started');checkpoint=true;});}
  catch{
    // Exceção do adaptador: sem prova de que o clique não ocorreu, só o checkpoint decide.
    if(!checkpoint)confirmation='not_submitted';
    else{
      await s.mark('verification_required');
      return outcome(s,'verification_required','Falha após o checkpoint de envio; resultado remoto incerto. Verificar manualmente, sem reenvio.');
    }
  }
  if(confirmation==='not_submitted'||confirmation==='not_submitted_postback'){
    if(checkpoint){
      // Defesa: com o checkpoint gravado o clique pode ter ocorrido; nunca tratar como não enviado.
      await s.mark('verification_required');
      return outcome(s,'verification_required','Falha após o checkpoint de envio; resultado remoto incerto. Verificar manualmente, sem reenvio.');
    }
    const postback=confirmation==='not_submitted_postback';
    // Postback do próprio portal antes do clique: nada salvo pelo agente, mas o formulário pode ter sido enviado
    // pelo portal. Vai para revisão manual (nunca reprocessado automaticamente), sem verification_required.
    if(postback)await s.mark('review_required');
    try{await timer.step('cpi_close_unsaved',()=>s.closeUnsavedDetail());}
    catch(error){throw new Error('Modal da pesquisa CPI não foi fechado; portal bloqueado. Feche o detalhe manualmente no Edge.',{cause:error});}
    if(postback)return outcome(s,'review_required','O portal enviou o formulário antes do clique em Alterar; nada foi salvo pelo agente. Modal fechado sem salvar; conferir a pesquisa manualmente.');
    return outcome(s,'not_submitted','Falha antes do clique em Alterar; nada foi salvo. Modal fechado sem salvar; a pesquisa será reprocessada com o mesmo PDF, sem nova consulta.');
  }
  if(confirmation==='confirmed'||confirmation==='confirmed_auxiliary_404'){
    // O envio remoto foi confirmado, mas a finalização local ainda pode falhar.
    // Persistir uma pendência antes de fechar; nunca liberar reenvio ao retomar.
    await s.mark('review_required');
    try {
      await timer.step('cpi_close_detail',()=>s.closeCompletedDetail());
      await s.mark('completed');
    } catch {
      // Falha no fechamento, atualização da listagem ou persistência da conclusão:
      // manter a pendência visível e impedir segundo envio.
      return outcome(s,'review_required','Resposta salva, mas o fechamento ou o registro da conclusão CPI não foi confirmado. Verificação manual necessária; não reenviar.');
    }
    if(confirmation==='confirmed_auxiliary_404')return outcome(s,'completed',
      'Resposta CPI confirmada e janela fechada; erro 404 do recurso auxiliar cpi_api_request.aspx observado. Verificar a integracao externa.',
      'auxiliary_404');
    return outcome(s,'completed','Resposta CPI confirmada, modal fechado e próxima solicitação liberada.');
  }
  await s.mark('verification_required');
  return outcome(s,'verification_required','Envio efetuado sem confirmação suficiente; verificar manualmente, sem reenvio.');
}

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
import type { CpiFinalizeReport } from './response-confirmation.ts';
import { NULL_TIMER, type StepTimer } from '../step-timing.ts';

/** Avisos que não alteram o estado da pesquisa: 404 auxiliar, modal não fechado, listagem não atualizada. */
export type CpiCycleWarning = 'auxiliary_404'|'modal_open'|'listing_stale';
/**
 * `browserHold`: liberação operacional negada, independente do estado da pesquisa. A janela da pesquisa ficou
 * aberta (ou o estado não pôde ser lido) e o agente não deve abrir outra pesquisa até o operador fechá-la.
 */
export type CpiCycleOutcome = {state:'completed'|'verification_required'|'pending'|'review_required'|'dry_run'; pesquisaId:string;solicitacaoId:string;message:string;warnings?:CpiCycleWarning[];reviewReason?:JudicialIssueCode;browserHold?:true};
export interface FullCycleServices {
  account:string;
  ids:CpiPendingRowId;
  outputFolder:string;
  getCpf():Promise<string>;
  getJob():Promise<CpiWorkItem|null>;
  claim():Promise<CpiWorkItem>;
  mark(stage:CpiWorkStage, updates?:Pick<CpiWorkItem,'historyRecordId'|'classification'|'reviewReason'>):Promise<CpiWorkItem>;
  /** Só após prova local de que nenhum POST/clique de envio ocorreu: restaura `pdf_ready` para retomada segura. */
  recordNotSubmitted():Promise<CpiWorkItem>;
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
  uploadAndSave(pdfPath:string,classification:'restrictions'|'information',mode?:'save'|'dry_run'):Promise<'confirmed'|'confirmed_auxiliary_404'|'unverified'|'not_submitted'|'not_submitted_held'|'dry_run_ok'>;
  /** Prova de persistência por leitura independente, depois fechamento do modal e atualização da listagem. */
  finalizeSubmitted():Promise<CpiFinalizeReport>;
  /** Modo ensaio (somente desenvolvimento): preenche e anexa, cancela a confirmação e não salva. */
  dryRun?:boolean;
  /** Fecha o formulário ensaiado sem salvar (obrigatório quando `dryRun`). */
  closeWithoutSaving?():Promise<void>;
  /** Medição de duração por etapa; recebe apenas nomes fixos de etapa. */
  timer?:Pick<StepTimer,'step'>;
}
function outcome(args:FullCycleServices,state:CpiCycleOutcome['state'],message:string,warnings?:CpiCycleWarning[],reviewReason?:JudicialIssueCode):CpiCycleOutcome {
  return {...args.ids,state,message,...(warnings?.length?{warnings}:{}),...(reviewReason?{reviewReason}:{})};
}
const WARNING_TEXT:Record<CpiCycleWarning,string>={
  auxiliary_404:'erro 404 do recurso auxiliar cpi_api_request.aspx observado (verificar a integração externa)',
  modal_open:'a janela da pesquisa continua aberta; navegação automática interrompida até ela ser fechada manualmente',
  listing_stale:'a listagem não confirmou a atualização (será relida na próxima varredura)'
};
function withWarnings(message:string,warnings:CpiCycleWarning[]):string{
  return warnings.length?`${message} Avisos: ${warnings.map(w=>WARNING_TEXT[w]).join('; ')}.`:message;
}
/** Avisos visuais/auxiliares da finalização; nenhum deles altera o veredito de persistência. */
function finalizeWarnings(confirmation:string,report:CpiFinalizeReport|null):CpiCycleWarning[]{
  const warnings:CpiCycleWarning[]=[];
  if(confirmation==='confirmed_auxiliary_404'||report?.auxiliary404)warnings.push('auxiliary_404');
  // Sem relatório o estado do navegador é desconhecido: tratado como janela aberta (fail-closed).
  if(!report||!report.browserReleased)warnings.push('modal_open');
  if(report?.persistence==='confirmed'&&report.browserReleased&&report.listing!=='refreshed')warnings.push('listing_stale');
  return warnings;
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
  if(s.dryRun){
    // Ensaio: sem checkpoint de envio. O item permanece em pdf_ready e pode ser processado depois de verdade.
    if(!s.closeWithoutSaving)throw new Error('Modo ensaio sem fechamento do formulário configurado.');
    const rehearsal=await s.uploadAndSave(pdf,classification.result,'dry_run');
    if(rehearsal==='not_submitted'||rehearsal==='not_submitted_held'){
      await s.mark('review_required');
      const result=outcome(s,'review_required','Ensaio: falha ao preencher ou anexar no formulário CPI; nada foi salvo. Revisão manual necessária.');
      return rehearsal==='not_submitted_held'?{...result,browserHold:true}:result;
    }
    if(rehearsal!=='dry_run_ok'){
      await s.mark('verification_required');
      return outcome(s,'verification_required','Ensaio: o portal registrou atividade inesperada no formulário; verificar manualmente, sem reenvio.');
    }
    await s.closeWithoutSaving();
    const label=classification.result==='restrictions'?'Sim, Consta Restrições':'Há Informações';
    return outcome(s,'dry_run',`Ensaio concluído (${label}): campos preenchidos e PDF anexado; nada foi salvo.`);
  }
  // Sem retry após esta marcação: eventual timeout ou queda pode significar envio já aceito.
  await s.mark('submit_started');
  let confirmation:Awaited<ReturnType<FullCycleServices['uploadAndSave']>>;
  try{confirmation=await s.uploadAndSave(pdf,classification.result);}
  catch{
    await s.mark('verification_required');
    return outcome(s,'verification_required','Falha após o checkpoint de envio; resultado remoto incerto. Verificar manualmente, sem reenvio.');
  }
  if(confirmation==='not_submitted'||confirmation==='not_submitted_held'){
    // O checkpoint foi gravado antes do primeiro efeito possível. Só esta prova local permite voltar a `pdf_ready`;
    // queda do processo, POST observado ou qualquer incerteza mantém `submit_started`/`verification_required`.
    await s.recordNotSubmitted();
    const result=outcome(s,'pending','Falha comprovada antes do envio CPI; nenhum envio foi realizado. O item permanece recuperável por GET, sem nova consulta paga.');
    return confirmation==='not_submitted_held'?{...result,browserHold:true}:result;
  }
  if(confirmation==='confirmed'||confirmation==='confirmed_auxiliary_404'){
    // O formulário aceitou o envio, o que não prova persistência. O item permanece em submit_started
    // (bloqueante, inclusive após reinício) até a leitura independente decidir; nunca há reenvio.
    let report:CpiFinalizeReport|null=null;
    try{report=await timer.step('cpi_close_detail',()=>s.finalizeSubmitted());}
    catch{/* Sem leitura conclusiva: tratado como persistência não comprovada. */}
    const warnings=finalizeWarnings(confirmation,report);
    // Persistência remota e liberação do navegador são decididas separadamente.
    const hold=(result:CpiCycleOutcome):CpiCycleOutcome=>warnings.includes('modal_open')?{...result,browserHold:true}:result;
    if(report?.persistence!=='confirmed'){
      await s.mark('verification_required');
      return hold(outcome(s,'verification_required',withWarnings(report?.persistence==='absent'
        ?'Formulário enviado, mas a CPI não exibe a resposta completa (status, resultado, data, fonte ou indicação "Documento PDF"). Verificar manualmente, sem reenvio.'
        :'Formulário enviado, mas a resposta salva não pôde ser lida na CPI. Resultado remoto incerto; verificar manualmente, sem reenvio.',warnings),warnings));
    }
    try{await s.mark('completed');}
    catch{
      // A pesquisa continua em submit_started (bloqueante) e aparece nas pendências para reconciliação.
      return hold(outcome(s,'review_required',withWarnings('Resposta confirmada na CPI, mas a conclusão local não foi gravada. Reconciliar manualmente; não reenviar.',warnings),warnings));
    }
    // "Documento PDF" é a indicação exibida pelo portal; o arquivo remoto não é conferido (sem contrato verificável).
    return hold(outcome(s,'completed',withWarnings(`Resposta CPI confirmada (status, resultado, data, fonte e indicação "Documento PDF")${
      warnings.includes('modal_open')?'.':'; próxima solicitação liberada.'}`,warnings),warnings));
  }
  await s.mark('verification_required');
  return outcome(s,'verification_required','Envio efetuado sem confirmação suficiente; verificar manualmente, sem reenvio.');
}

import { isValidCpf } from '../shared/cpf.ts';
import { normalizeDeskdataResponse } from '../shared/normalizer.ts';
import { assertRecoveredCpf } from '../shared/query-identity.ts';
import { QueryRecovery, type ReceivedQuery } from '../shared/query-recovery.ts';
import type { ReportPayload, QueryOutcome } from '../shared/types.ts';
import { assertQueryRecordIdentity, type QueryHistoryStore } from './query-history.ts';

export interface PersonReportBinding {
  account:string;
  recordId:string;
  cpf:string;
  queryCode?:string;
}
export interface ReceivedPersonQuery extends ReceivedQuery, PersonReportBinding {}
export interface BoundPersonReport extends PersonReportBinding { report:ReportPayload }
interface Services {
  history:Pick<QueryHistoryStore,'findById'|'addPdf'>;
  currentAccount:()=>string|null;
  getOutputFolder:()=>Promise<string|null>;
  savePdf:(folder:string,report:ReportPayload)=>Promise<QueryOutcome>;
}

/** Resposta e relatório conservam o vínculo original durante toda a sessão. */
export class PersonReportService {
  private readonly recovery=new QueryRecovery<ReceivedPersonQuery>();
  private lastReport:BoundPersonReport|null=null;
  private readonly services:Services;
  constructor(services:Services){this.services=services;}

  private assertAccount(binding:PersonReportBinding):void {
    if(!binding.account || this.services.currentAccount()!==binding.account){
      throw new Error('Conta da consulta não corresponde à sessão atual.');
    }
  }
  private async validateBinding(binding:PersonReportBinding):Promise<void>{
    this.assertAccount(binding);
    if(!isValidCpf(binding.cpf))throw new Error('CPF da consulta inválido.');
    const record=await this.services.history.findById(binding.account,binding.recordId);
    this.assertAccount(binding);
    if(!record)throw new Error('Registro da consulta indisponível no histórico desta conta.');
    assertQueryRecordIdentity(record,{account:binding.account,kind:'person',document:binding.cpf,queryCode:binding.queryCode});
  }
  async processReceived(received:ReceivedPersonQuery):Promise<QueryOutcome>{
    const result=structuredClone(received);
    await this.validateBinding(result);
    assertRecoveredCpf(result.payload,result.cpf);
    this.recovery.remember(result);
    this.lastReport=null;
    const data=normalizeDeskdataResponse(result.payload);
    const bound:BoundPersonReport={account:result.account,recordId:result.recordId,cpf:result.cpf,queryCode:result.queryCode,
      report:{cpf:result.cpf,consultedAt:result.consultedAt,queryCode:result.queryCode,data}};
    this.lastReport=bound;
    return this.exportReport(bound);
  }
  async exportReport(value:BoundPersonReport):Promise<QueryOutcome>{
    const bound=structuredClone(value);
    if(bound.report.cpf!==bound.cpf || bound.report.queryCode!==bound.queryCode){
      throw new Error('A identidade do relatório não corresponde à consulta.');
    }
    assertRecoveredCpf({data:{basic:bound.report.data.basic?.value}},bound.cpf);
    await this.validateBinding(bound);
    const folder=await this.services.getOutputFolder();
    if(!folder)throw new Error('Selecione antes a pasta de destino dos PDFs.');
    await this.validateBinding(bound);
    const saved=await this.services.savePdf(folder,bound.report);
    await this.validateBinding(bound);
    await this.services.history.addPdf(bound.recordId,saved.path,
      {account:bound.account,kind:'person',document:bound.cpf,queryCode:bound.queryCode});
    return {...saved,recordId:bound.recordId};
  }
  async reprocessLastResponse():Promise<QueryOutcome>{
    const received=this.recovery.read();
    if(!received)throw new Error('Nenhuma resposta de consulta está disponível nesta sessão.');
    return this.processReceived(received);
  }
  async saveAgain():Promise<QueryOutcome>{
    if(!this.lastReport)throw new Error('Não há relatório disponível para novo salvamento nesta sessão.');
    return this.exportReport(this.lastReport);
  }
  readFor(account:string,cpf:string,recordId:string):ReceivedPersonQuery|null {
    const cached=this.recovery.read();
    return cached && cached.account===account && cached.cpf===cpf && cached.recordId===recordId
      ? structuredClone(cached) : null;
  }
  status():{hasResponse:boolean;hasReport:boolean}{
    const account=this.services.currentAccount();
    return {hasResponse:!!account&&this.recovery.read()?.account===account,hasReport:!!account&&this.lastReport?.account===account};
  }
  clearReport():void {this.lastReport=null;}
  clear():void {this.recovery.clear();this.clearReport();}
}

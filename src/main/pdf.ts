import { BrowserWindow } from 'electron';
import { renderAndSave as renderPdf, type PrintWindow } from './pdf-render.ts';
import { companyPdfName, cpiPdfName, pdfDate, personPdfName, pisPdfName } from './pdf-names.ts';
import { renderCompanyHtml, type CompanyRecord } from '../shared/company-report.ts';
import { renderReportHtml } from '../shared/report.ts';
import { renderPisPdfHtml, type PisRecord } from '../shared/pis-report.ts';
import type { ReportPayload, QueryOutcome } from '../shared/types.ts';
import type { CpiPendingRowId } from './cpi/pending-rows.ts';

function createPrintWindow():PrintWindow{
  return new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true}});
}
function renderAndSave(folder:string,html:string,filename:string,queryCode?:string):Promise<QueryOutcome>{
  return renderPdf(createPrintWindow,folder,html,filename,queryCode);
}

/** Consulta manual de pessoa: RELATORIO_<queryCode>_<data>.pdf. */
export async function saveReportPdf(folder:string,report:ReportPayload):Promise<QueryOutcome>{
  return renderAndSave(folder,renderReportHtml(report),personPdfName(report.queryCode,pdfDate(report.consultedAt)),report.queryCode);
}
/** Resposta CPI: CPI_<pesquisaId>_<solicitacaoId>_<data>.pdf, mesmo conteúdo do relatório de pessoa. */
export async function saveCpiReportPdf(folder:string,report:ReportPayload,ids:CpiPendingRowId):Promise<QueryOutcome>{
  return renderAndSave(folder,renderReportHtml(report),cpiPdfName(ids,pdfDate(report.consultedAt)),report.queryCode);
}
export async function savePisReportPdf(folder:string,record:PisRecord,queryCode?:string):Promise<QueryOutcome>{
  return renderAndSave(folder,renderPisPdfHtml(record),pisPdfName(queryCode,pdfDate()),queryCode);
}

export async function saveCompanyReportPdf(folder:string,record:CompanyRecord,cnpj:string,consultedAt:string,queryCode?:string):Promise<QueryOutcome>{
  return renderAndSave(folder,renderCompanyHtml(record,cnpj,consultedAt),companyPdfName(queryCode,pdfDate(consultedAt)),queryCode);
}

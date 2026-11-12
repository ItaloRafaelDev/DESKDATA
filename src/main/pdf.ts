import { BrowserWindow } from 'electron';
import { renderAndSave as renderPdf, type PrintWindow } from './pdf-render.ts';
import { renderCompanyHtml, type CompanyRecord } from '../shared/company-report.ts';
import { renderReportHtml } from '../shared/report.ts';
import { renderPisPdfHtml, type PisRecord } from '../shared/pis-report.ts';
import type { ReportPayload, QueryOutcome } from '../shared/types.ts';

function createPrintWindow():PrintWindow{
  return new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true}});
}
function renderAndSave(folder:string,html:string,filename:string,queryCode?:string):Promise<QueryOutcome>{
  return renderPdf(createPrintWindow,folder,html,filename,queryCode);
}

export async function saveReportPdf(folder:string,report:ReportPayload):Promise<QueryOutcome>{
  const date=new Date(report.consultedAt).toISOString().slice(0,10);
  return renderAndSave(folder,renderReportHtml(report),`RELATORIO_${report.cpf}_${date}`,report.queryCode);
}
export async function savePisReportPdf(folder:string,record:PisRecord,cpf:string,queryCode?:string):Promise<QueryOutcome>{
  const date=new Date().toISOString().slice(0,10);
  return renderAndSave(folder,renderPisPdfHtml(record),`PIS_${cpf}_${date}`,queryCode);
}

export async function saveCompanyReportPdf(folder:string,record:CompanyRecord,cnpj:string,consultedAt:string,queryCode?:string):Promise<QueryOutcome>{
  const date=new Date(consultedAt).toISOString().slice(0,10);
  return renderAndSave(folder,renderCompanyHtml(record,cnpj,consultedAt),`CNPJ_${cnpj}_${date}`,queryCode);
}

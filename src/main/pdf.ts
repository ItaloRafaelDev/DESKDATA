import { BrowserWindow } from 'electron';
import { writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { renderCompanyHtml, type CompanyRecord } from '../shared/company-report.ts';
import { renderReportHtml } from '../shared/report.ts';
import { renderPisPdfHtml, type PisRecord } from '../shared/pis-report.ts';
import type { ReportPayload, QueryOutcome } from '../shared/types.ts';

async function writeUnique(folder:string, basename:string, pdf:Buffer):Promise<string>{
  await stat(folder).then(s=>{if(!s.isDirectory())throw new Error('Destino não é uma pasta.');});
  for(let i=0;i<100;i++){
    const suffix=i===0?'':`-${String(i+1).padStart(2,'0')}`;
    const path=join(folder,`${basename}${suffix}.pdf`);
    try{await writeFile(path,pdf,{flag:'wx'});return path;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  }
  throw new Error('Limite de nomes disponíveis atingido.');
}
async function renderAndSave(folder:string,html:string,filename:string,queryCode?:string):Promise<QueryOutcome>{
  const printWindow=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true}});
  try {
    await printWindow.loadURL('about:blank');
    await printWindow.webContents.executeJavaScript(`document.open();document.write(${JSON.stringify(html)});document.close();`);
    await printWindow.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
    const pdf=await printWindow.webContents.printToPDF({pageSize:'A4',printBackground:true,preferCSSPageSize:true,displayHeaderFooter:false});
    if(!pdf.subarray(0,5).equals(Buffer.from('%PDF-')))throw new Error('Gerador não retornou PDF válido.');
    const path=await writeUnique(folder,filename,pdf);
    return {path,savedAt:new Date().toISOString(),queryCode};
  } finally{if(!printWindow.isDestroyed())printWindow.destroy();}
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

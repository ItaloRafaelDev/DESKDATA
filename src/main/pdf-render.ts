import { writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { QueryOutcome } from '../shared/types.ts';
import { PDF_MAX_COPIES_PER_DAY } from './pdf-names.ts';
import { isDeadlineError, withDeadline } from './deadline.ts';

/** Tempo máximo para carregar o HTML, aguardar fontes e gerar o PDF. */
export const PDF_RENDER_TIMEOUT_MS=120_000;
/** Modelos usam apenas <style> inline e fontes do sistema: sem scripts, rede, frames ou formulários. */
export const PRINT_CSP="default-src 'none'; style-src 'unsafe-inline'; img-src data:; object-src 'none'; base-uri 'none'; form-action 'none'";

/** Janela mínima usada na impressão (subconjunto de BrowserWindow). */
export interface PrintWindow {
  loadURL(url:string):Promise<unknown>;
  isDestroyed():boolean;
  destroy():void;
  webContents:{executeJavaScript(code:string):Promise<unknown>;printToPDF(options:Record<string,unknown>):Promise<Buffer>};
}

/** Insere a CSP de impressão como primeiro elemento do <head>, antes de qualquer recurso. */
export function withPrintCsp(html:string):string{
  const meta=`<meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">`;
  const head=/<head(?:\s[^>]*)?>/i.exec(html);
  if(head)return html.slice(0,head.index+head[0].length)+meta+html.slice(head.index+head[0].length);
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

/** Prazo das operações de disco na pasta do usuário (pode ser unidade de rede) — E3/W6. */
export const PDF_FILE_TIMEOUT_MS=30_000;
export interface PdfFileSystem {
  stat(path:string):Promise<{isDirectory():boolean}>;
  writeFile(path:string,data:Buffer,options:{flag:string}):Promise<void>;
}
export interface PdfFileOptions { timeoutMs?:number; fs?:PdfFileSystem }

async function writeUnique(fs:PdfFileSystem, folder:string, basename:string, pdf:Buffer):Promise<string>{
  await fs.stat(folder).then(s=>{if(!s.isDirectory())throw new Error('Destino não é uma pasta.');});
  // Primeiro arquivo sem sufixo; regerações no mesmo dia recebem -02 a -99 (formato -NN), nunca sobrescrevem.
  for(let i=0;i<PDF_MAX_COPIES_PER_DAY;i++){
    const suffix=i===0?'':`-${String(i+1).padStart(2,'0')}`;
    const path=join(folder,`${basename}${suffix}.pdf`);
    try{await fs.writeFile(path,pdf,{flag:'wx'});return path;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  }
  throw new Error('Limite de nomes disponíveis atingido.');
}

/**
 * Gravação com prazo. Se o disco não responder, o caminho não é devolvido nem registrado: um arquivo gravado
 * tardiamente nunca é anexado (a CPI só aceita caminhos registrados na consulta) e a regeração usa novo sufixo.
 */
async function writeWithin(files:PdfFileOptions, folder:string, basename:string, pdf:Buffer):Promise<string>{
  const ms=files.timeoutMs??PDF_FILE_TIMEOUT_MS;
  try{return await withDeadline(writeUnique(files.fs??{stat,writeFile},folder,basename,pdf),ms,'pdf_write');}
  catch(error){
    if(!isDeadlineError(error))throw error;
    throw new Error(`A pasta de destino não respondeu em ${Math.max(1,Math.round(ms/1000))} s. O PDF não foi registrado; gere-o novamente.`,{cause:error});
  }
}

async function generate(printWindow:PrintWindow,html:string):Promise<Buffer>{
  await printWindow.loadURL('about:blank');
  await printWindow.webContents.executeJavaScript(`document.open();document.write(${JSON.stringify(withPrintCsp(html))});document.close();`);
  await printWindow.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  return printWindow.webContents.printToPDF({pageSize:'A4',printBackground:true,preferCSSPageSize:true,displayHeaderFooter:false});
}

export async function renderAndSave(createWindow:()=>PrintWindow,folder:string,html:string,filename:string,queryCode?:string,timeoutMs=PDF_RENDER_TIMEOUT_MS,files:PdfFileOptions={}):Promise<QueryOutcome>{
  const printWindow=createWindow();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const generation=generate(printWindow,html);
    generation.catch(()=>{}); // após o timeout, a geração abandonada pode rejeitar com a janela destruída
    const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{
      if(!printWindow.isDestroyed())printWindow.destroy();
      reject(new Error(`A geração do PDF excedeu ${Math.round(timeoutMs/1000)} s e foi cancelada. Nenhum arquivo foi gravado.`));
    },timeoutMs);});
    const pdf=await Promise.race([generation,timeout]);
    clearTimeout(timer);
    if(!Buffer.isBuffer(pdf)||!pdf.subarray(0,5).equals(Buffer.from('%PDF-')))throw new Error('Gerador não retornou PDF válido.');
    const path=await writeWithin(files,folder,filename,pdf);
    return {path,savedAt:new Date().toISOString(),queryCode};
  } finally{clearTimeout(timer);if(!printWindow.isDestroyed())printWindow.destroy();}
}

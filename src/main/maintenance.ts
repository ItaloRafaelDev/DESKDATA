import { lstat, unlink } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import type { QueryHistoryStore } from './query-history.ts';

export interface MaintenanceSelection {pdfs:boolean;history:boolean}
export interface MaintenancePreview {recordCount:number;pdfCount:number;pendingCount:number}
export interface MaintenanceResult {deletedPdfs:number;missingPdfs:number;deletedRecords:number}

/** Reconhece nomes efetivamente gerados pelas diferentes versões do DESKDATA. */
const REPORT_NAME=/^(?:RELATORIO_\d{11}|PIS_\d{11}|CNPJ_\d{14}|DESKDATA_\d{11})_\d{4}-\d{2}-\d{2}(?:-\d{2,3})?\.pdf$/i;
function managedFile(path:string):boolean{
  return typeof path==='string' && isAbsolute(path) && REPORT_NAME.test(basename(path));
}

/** Exclusão local explícita; nunca varre a pasta arbitrária escolhida pelo usuário. */
export class MaintenanceService {
  private cleaning=false;
  private readonly history:QueryHistoryStore;
  constructor(history:QueryHistoryStore){this.history=history;}
  async preview():Promise<MaintenancePreview>{
    const rows=await this.history.listAll();
    const files=new Set(rows.flatMap(record=>record.pdfPaths));
    return {recordCount:rows.length,pdfCount:files.size,pendingCount:rows.filter(r=>r.status==='pending'||r.status==='uncertain').length};
  }
  async clean(selection:MaintenanceSelection):Promise<MaintenanceResult>{
    if(!selection || typeof selection.pdfs!=='boolean'||typeof selection.history!=='boolean' || (!selection.pdfs&&!selection.history))throw new Error('Selecione ao menos uma opção de limpeza.');
    if(this.cleaning)throw new Error('Uma limpeza já está em andamento.');
    this.cleaning=true;
    try{
      const rows=await this.history.listAll();
      const paths=[...new Set(rows.flatMap(record=>record.pdfPaths))];
      if(selection.pdfs && paths.some(file=>!managedFile(file)))throw new Error('O histórico contém um caminho de PDF não reconhecido. A limpeza foi interrompida antes de apagar qualquer arquivo.');
      const cleared=new Set<string>();
      let deletedPdfs=0,missingPdfs=0;
      if(selection.pdfs){
        try{
          for(const file of paths){
            let info;
            try{info=await lstat(file);}catch(error){
              if((error as NodeJS.ErrnoException).code==='ENOENT'){missingPdfs++;cleared.add(file);continue;}
              throw error;
            }
            if(!info.isFile() || info.isSymbolicLink())throw new Error('Arquivo não regular ou link simbólico. Limpeza interrompida.');
            await unlink(file);
            cleared.add(file);deletedPdfs++;
          }
        }catch(error){
          // Se ocorrer falha parcial, preservar as referências dos arquivos que não foram removidos.
          await this.history.removePdfReferences(cleared);
          // eslint-disable-next-line preserve-caught-error -- a causa é erro de fs com o caminho do PDF (RELATORIO_<CPF>_...), que não pode ir para logs.
          throw new Error(`Limpeza parcial. ${deletedPdfs} PDF(s) excluído(s); os demais registros foram preservados. ${error instanceof Error?error.message:'Falha ao excluir arquivo.'}`);
        }
      }
      if(selection.history)await this.history.clearAll();
      else if(selection.pdfs)await this.history.removePdfReferences(cleared);
      return {deletedPdfs,missingPdfs,deletedRecords:selection.history?rows.length:0};
    }finally{this.cleaning=false;}
  }
}

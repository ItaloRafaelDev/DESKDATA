import { validateCpiRowId, type CpiPendingRowId } from './cpi/pending-rows.ts';

/**
 * Nomes de arquivo dos relatórios (decisão D2 do plano v0.2). Nenhum nome contém CPF ou CNPJ:
 * consultas manuais usam o código da consulta Deskdata; respostas CPI usam pesquisaId e solicitacaoId.
 * Regerações no mesmo dia recebem sufixo -NN (-02 a -99) em pdf-render.ts.
 */
export const PDF_NO_CODE='SEM-CODIGO';
export const PDF_MAX_COPIES_PER_DAY=99;
const QUERY_CODE=/^Q-[A-F0-9]{10}$/;
const DATE=/^\d{4}-\d{2}-\d{2}$/;

/** Data AAAA-MM-DD usada nos nomes (UTC, como nas versões anteriores). */
export function pdfDate(at:string|Date=new Date()):string {return new Date(at).toISOString().slice(0,10);}
function checkedDate(date:string):string {if(!DATE.test(date))throw new Error('Data inválida para o nome do PDF.');return date;}
/** Só um código de consulta válido entra no nome; qualquer outro valor (inclusive um documento) vira SEM-CODIGO. */
function codePart(queryCode?:string):string {return typeof queryCode==='string'&&QUERY_CODE.test(queryCode)?queryCode:PDF_NO_CODE;}

export function personPdfName(queryCode:string|undefined,date:string):string {return `RELATORIO_${codePart(queryCode)}_${checkedDate(date)}`;}
export function pisPdfName(queryCode:string|undefined,date:string):string {return `PIS_${codePart(queryCode)}_${checkedDate(date)}`;}
export function companyPdfName(queryCode:string|undefined,date:string):string {return `CNPJ_${codePart(queryCode)}_${checkedDate(date)}`;}
export function cpiPdfName(ids:CpiPendingRowId,date:string):string {
  const valid=validateCpiRowId(ids);
  if(!valid)throw new Error('Identificadores CPI inválidos para o nome do PDF.');
  return `CPI_${valid.pesquisaId}_${valid.solicitacaoId}_${checkedDate(date)}`;
}
/** Aceita somente o PDF CPI do par pesquisaId/solicitacaoId informado, com sufixo opcional -NN. */
export function cpiPdfPattern(ids:CpiPendingRowId):RegExp {
  const valid=validateCpiRowId(ids);
  if(!valid)throw new Error('Identificadores CPI inválidos para validar o PDF.');
  return new RegExp(`^CPI_${valid.pesquisaId}_${valid.solicitacaoId}_\\d{4}-\\d{2}-\\d{2}(?:-\\d{2})?\\.pdf$`,'i');
}

/**
 * Nomes gerados por qualquer versão do DESKDATA, usados só pela limpeza de arquivos registrados no histórico.
 * O segmento do meio é genérico (código, SEM-CODIGO ou o documento das versões anteriores), sem padrão de CPF/CNPJ:
 * arquivos antigos continuam reconhecíveis sem serem renomeados.
 */
const MANAGED_PDF=/^(?:(?:RELATORIO|PIS|CNPJ|DESKDATA)_[A-Z0-9-]{10,14}|CPI_[1-9]\d{3,11}_[1-9]\d{3,11})_\d{4}-\d{2}-\d{2}(?:-\d{2,3})?\.pdf$/i;
export function isManagedPdfName(name:string):boolean {return MANAGED_PDF.test(name);}

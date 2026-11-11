import { normalizeToken } from './localization.ts';

export const JUDICIAL_ISSUE_CODES = ['missing_dataset','dataset_error','missing_items','invalid_items',
  'invalid_counter','total_mismatch','role_count_exceeds_total','invalid_item','status_mismatch',
  'missing_court_type','empty_court_type','invalid_court_type','unknown_court_type',
  'unverified_competence_alias','conflicting_competence'] as const;
export type JudicialIssueCode = typeof JUDICIAL_ISSUE_CODES[number];
/** Somente códigos, nomes de campos e posições; nunca valores pessoais do processo. */
export interface JudicialIssue { code:JudicialIssueCode; field?:string; itemIndex?:number }
function object(value:unknown):Record<string,unknown>|null {
  return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
}
export function inspectJudicialDataset(value:unknown):JudicialIssue|null {
  const data=object(value);
  if(!data)return {code:'missing_dataset'};
  const status=object(data.status);
  if(data.error||(status&&'code' in status&&![4000,2000].includes(Number(status.code))))return {code:'dataset_error'};
  if(!Object.hasOwn(data,'items'))return {code:'missing_items',field:'items'};
  if(!Array.isArray(data.items))return {code:'invalid_items',field:'items'};
  for(const field of ['total','total_as_author','total_as_defendant','total_as_other']){
    if(Object.hasOwn(data,field)&&(!Number.isSafeInteger(data[field])||Number(data[field])<0))return {code:'invalid_counter',field};
  }
  if(Object.hasOwn(data,'total')&&data.total!==data.items.length)return {code:'total_mismatch',field:'total'};
  for(const field of ['total_as_author','total_as_defendant','total_as_other']){
    // Papéis podem se sobrepor; o contrato não autoriza somar esses contadores.
    if(Object.hasOwn(data,field)&&Number(data[field])>data.items.length)return {code:'role_count_exceeds_total',field};
  }
  for(let itemIndex=0;itemIndex<data.items.length;itemIndex++){
    if(!object(data.items[itemIndex]))return {code:'invalid_item',itemIndex};
  }
  return null;
}

/** Vocabulário operacional já utilizado pelo projeto; não é um enum publicado pela API. */
const knownTypes = new Set(['CRIMINAL','CIVIL','TRABALHISTA','FAZENDA','ESPECIAL CIVEL','TAX']);
function token(value:string):string {
  const result=normalizeToken(value).replace(/\s+/g,' ');
  return result==='CIVEL'?'CIVIL':result;
}
export function isExplicitCriminal(value:unknown):boolean {return typeof value==='string'&&token(value)==='CRIMINAL';}
type CourtField='court_type'|'competence'|'competencia';
export interface JudicialCompetence {
  state:'known'|'review_required';
  criminal:boolean;
  displayValue?:string;
  source?:CourtField;
  issue?:JudicialIssue;
}
export function resolveJudicialCompetence(item:Record<string,unknown>):JudicialCompetence {
  const fields:CourtField[]=['court_type','competence','competencia'];
  const source=fields.find(field=>typeof item[field]==='string'&&!!(item[field] as string).trim());
  const displayValue=source?(item[source] as string).trim():undefined;
  const review=(code:JudicialIssueCode,field: string='court_type'):JudicialCompetence=>
    ({state:'review_required',criminal:false,displayValue,source,issue:{code,field}});
  for(const field of fields){
    if(Object.hasOwn(item,field)&&item[field]!==undefined&&typeof item[field]!=='string')return review('invalid_court_type',field);
  }
  const explicit=typeof item.court_type==='string'?item.court_type.trim():'';
  if(!explicit){
    if(source)return review('unverified_competence_alias',source);
    return review(Object.hasOwn(item,'court_type')?'empty_court_type':'missing_court_type');
  }
  const canonical=token(explicit);
  if(!knownTypes.has(canonical))return review('unknown_court_type');
  for(const field of ['competence','competencia'] as const){
    const alias=item[field];
    if(typeof alias==='string'&&alias.trim()&&token(alias)!==canonical)return review('conflicting_competence',field);
  }
  return {state:'known',criminal:canonical==='CRIMINAL',displayValue,source:'court_type'};
}

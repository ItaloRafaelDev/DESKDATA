import type { NormalizedData } from '../../shared/types.ts';
import { inspectJudicialDataset, type JudicialIssue } from '../../shared/judicial.ts';
import { normalizeToken } from '../../shared/localization.ts';

export type CpiPersonClassification =
  | { state: 'classified'; result: 'restrictions' | 'information'; count: number }
  | { state: 'review_required'; reason: 'incomplete_lawsuits' | 'unknown_competence' };

/** Campos da Deskdata que podem informar a competência do processo. */
const COMPETENCE_FIELDS = ['court_type', 'competence', 'competencia'] as const;

/**
 * Regra operacional aprovada para a CPI: a palavra CRIMINAL em qualquer campo de competência
 * (Criminal, Especial Criminal, Vara Criminal...) indica restrição. Vazio, ausente ou outra
 * competência não é restrição. Não equivale a presunção de culpa ou responsabilidade.
 */
export function isCriminalCompetenceItem(item: Record<string, unknown>): boolean {
  return COMPETENCE_FIELDS.some(field => {
    const value = item[field];
    return typeof value === 'string' && /\bCRIMINAL\b/.test(normalizeToken(value).replace(/\s+/g, ' '));
  });
}

/** Regras operacionais da CPI. Não equivalem a presunção de culpa ou responsabilidade. */
export function classifyCpiPerson(data: NormalizedData): CpiPersonClassification {
  return assessCpiPerson(data).classification;
}
export function assessCpiPerson(data:NormalizedData):{classification:CpiPersonClassification;issues:JudicialIssue[]} {
  const lawsuits = data?.lawsuits;
  const payload = lawsuits?.value;
  const issue=inspectJudicialDataset(payload);
  if(issue)return {classification:{state:'review_required',reason:'incomplete_lawsuits'},issues:[issue]};
  const items=(payload as {items:Record<string,unknown>[]}).items;
  if(lawsuits.status!==(items.length?'ok':'empty')){
    return {classification:{state:'review_required',reason:'incomplete_lawsuits'},issues:[{code:'status_mismatch'}]};
  }
  const issues:JudicialIssue[]=[];
  let criminal = false;
  for (const [itemIndex,item] of items.entries()) {
    // Campo de competência presente com tipo não textual indica resposta corrompida: revisão.
    const invalid=COMPETENCE_FIELDS.find(field=>Object.hasOwn(item,field)&&item[field]!==undefined&&item[field]!==null&&typeof item[field]!=='string');
    if(invalid){issues.push({code:'invalid_court_type',field:invalid,itemIndex});continue;}
    if(isCriminalCompetenceItem(item))criminal=true;
  }
  return {classification:issues.length?{state:'review_required',reason:'unknown_competence'}:
    {state:'classified',result:criminal?'restrictions':'information',count:items.length},issues};
}

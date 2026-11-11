import type { NormalizedData } from '../../shared/types.ts';
import { inspectJudicialDataset, resolveJudicialCompetence, type JudicialIssue } from '../../shared/judicial.ts';

export type CpiPersonClassification =
  | { state: 'classified'; result: 'restrictions' | 'information'; count: number }
  | { state: 'review_required'; reason: 'incomplete_lawsuits' | 'unknown_competence' };

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
    const competence=resolveJudicialCompetence(item);
    if(competence.issue)issues.push({...competence.issue,itemIndex});
    else if(competence.criminal)criminal=true;
  }
  return {classification:issues.length?{state:'review_required',reason:'unknown_competence'}:
    {state:'classified',result:criminal?'restrictions':'information',count:items.length},issues};
}

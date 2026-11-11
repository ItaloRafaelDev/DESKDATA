import type { NormalizedData } from '../../shared/types.ts';
import { isCriminalCompetence } from '../../shared/report.ts';

export type CpiPersonClassification =
  | { state: 'classified'; result: 'restrictions' | 'information'; count: number }
  | { state: 'review_required'; reason: 'incomplete_lawsuits' | 'unknown_competence' };

/** Regras operacionais da CPI. Não equivalem a presunção de culpa ou responsabilidade. */
export function classifyCpiPerson(data: NormalizedData): CpiPersonClassification {
  const lawsuits = data?.lawsuits;
  const payload = lawsuits?.value;
  if (!lawsuits || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { state: 'review_required', reason: 'incomplete_lawsuits' };
  }
  const items = (payload as Record<string, unknown>).items;
  if (!Array.isArray(items) || (lawsuits.status === 'empty' && items.length !== 0)) {
    return { state: 'review_required', reason: 'incomplete_lawsuits' };
  }
  if (items.length === 0) {
    return lawsuits.status === 'empty'
      ? { state: 'classified', result: 'information', count: 0 }
      : { state: 'review_required', reason: 'incomplete_lawsuits' };
  }
  let unknownCompetence = false;
  let criminal = false;
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      unknownCompetence = true;
      continue;
    }
    const details = item as Record<string, unknown>;
    const competence = details.court_type ?? details.competence ?? details.competencia;
    if (typeof competence !== 'string' || !competence.trim()) unknownCompetence = true;
    else if (isCriminalCompetence(competence)) criminal = true;
  }
  if (unknownCompetence) return { state: 'review_required', reason: 'unknown_competence' };
  return { state: 'classified', result: criminal ? 'restrictions' : 'information', count: items.length };
}

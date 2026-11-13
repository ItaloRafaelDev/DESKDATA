import type { CpiHistoryOverview } from '../../shared/types.ts';
import type { QueryRecord } from '../query-history.ts';
import { validateStoredPdf } from '../ipc/context.ts';
import type { CpiWorkItem } from './workflow-store.ts';

const RECENT_LIMIT = 100;
const REVIEW_STAGES: ReadonlySet<string> = new Set(['verification_required', 'review_required', 'submit_started', 'query_started']);
interface HistoryReader { findManyById(account: string, ids: readonly string[]): Promise<Map<string, QueryRecord>> }

/**
 * Visão do histórico CPI (P8, E5): os registros vinculados às 100 respostas mais recentes são lidos numa única
 * operação do histórico, em vez de um `findById` por item na fila serial do SQLite. Só saem códigos CPI.
 */
export async function buildCpiHistoryOverview(who: string, items: readonly CpiWorkItem[], history: HistoryReader,
  pdfExists: (path: string) => Promise<boolean> = validateStoredPdf): Promise<CpiHistoryOverview> {
  const completed = items.filter(item => item.stage === 'completed');
  const reviewCount = items.filter(item => REVIEW_STAGES.has(item.stage)).length;
  const recent = completed.slice(0, RECENT_LIMIT);
  const records = await history.findManyById(who, recent.flatMap(item => item.historyRecordId ? [item.historyRecordId] : []));
  const available = async (item: CpiWorkItem): Promise<boolean> => {
    const record = item.historyRecordId ? records.get(item.historyRecordId) : undefined;
    if (!record || (record.kind !== 'person' && record.kind !== undefined) || record.account !== who) return false;
    for (const path of record.pdfPaths) if (await pdfExists(path)) return true;
    return false;
  };
  const rows = await Promise.all(recent.map(async item => ({ pesquisaId: item.pesquisaId, solicitacaoId: item.solicitacaoId,
    classification: item.classification ?? 'information', answeredAt: item.updatedAt, pdfAvailable: await available(item) })));
  return { completedCount: completed.length, reviewCount, items: rows };
}

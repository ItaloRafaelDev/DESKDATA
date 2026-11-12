import { isValidCpf } from '../../shared/cpf.ts';
import type { QueryRecord } from '../query-history.ts';
import { findCpiPersonPdf } from './person-pdf.ts';

export type CpiPersonHistoryState =
  | 'no_history' | 'not_ready' | 'folder_unconfigured' | 'pdf_unavailable' | 'pdf_available';

export interface CpiPersonHistoryResult {
  state: CpiPersonHistoryState;
  pesquisaId: string;
  solicitacaoId: string;
  recordDate?: string;
  /** Nenhum CPF, caminho local ou conteúdo de consulta atravessa o IPC. */
}

/** Fase 4A: somente leitura. Não cria consultas, não chama GET/POST e não abre PDF. */
export async function inspectCpiPersonHistory(args: {
  account: string;
  cpf: string;
  pesquisaId: string;
  solicitacaoId: string;
  outputFolder: string | null;
  findLatest: (account: string, cpf: string, kind: 'person') => Promise<QueryRecord | null>;
}): Promise<CpiPersonHistoryResult> {
  const { account, cpf, pesquisaId, solicitacaoId, outputFolder, findLatest } = args;
  if (!account.trim() || !isValidCpf(cpf)) throw new Error('Conta ou CPF da CPI inválido.');
  if (!/^[1-9]\d{3,11}$/.test(pesquisaId) || !/^[1-9]\d{3,11}$/.test(solicitacaoId)) {
    throw new Error('Identificadores da CPI inválidos.');
  }
  const base = { pesquisaId, solicitacaoId };
  const latest = await findLatest(account, cpf, 'person');
  if (!latest) return { ...base, state: 'no_history' };
  if (latest.account !== account || latest.cpf !== cpf ||
      (latest.kind !== undefined && latest.kind !== 'person')) {
    throw new Error('Histórico inconsistente: não é seguro associar esta consulta à CPI.');
  }
  const recordDate = latest.requestedAt;
  if (latest.status !== 'ready') return { ...base, state: 'not_ready', recordDate };
  if (!outputFolder) return { ...base, state: 'folder_unconfigured', recordDate };
  try {
    // Só conta o PDF CPI desta pesquisa; PDFs legados ou de outra pesquisa não são reutilizáveis.
    await findCpiPersonPdf(latest, cpf, outputFolder, { pesquisaId, solicitacaoId });
    return { ...base, state: 'pdf_available', recordDate };
  } catch {
    // Não retornar caminhos do disco, detalhes de arquivo ou informações pessoais.
    return { ...base, state: 'pdf_unavailable', recordDate };
  }
}

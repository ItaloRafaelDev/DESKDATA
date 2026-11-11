import { isValidCpf } from '../../shared/cpf.ts';
import type { QueryRecord } from '../query-history.ts';
import { findCpiPersonPdf } from './person-pdf.ts';
import { validateCpiRowId, type CpiPendingRowId } from './pending-rows.ts';

export type CpiPersonPreparationState =
  | 'requires_paid_authorization'
  | 'folder_unconfigured'
  | 'manual_review'
  | 'pending'
  | 'pdf_ready';

export interface CpiPersonPreparationResult extends CpiPendingRowId {
  state: CpiPersonPreparationState;
  reused: boolean;
}

type RecoveryOutcome = { state: 'pending' } | { state: 'ready' };

export interface PrepareCpiPersonPdfArgs {
  ids: CpiPendingRowId;
  account: string;
  cpf: string;
  outputFolder: string | null;
  findLatest: (account: string, cpf: string, kind: 'person') => Promise<QueryRecord | null>;
  /** DEVE usar somente GET por codigo existente, nunca POST. */
  recoverExisting: (record: QueryRecord) => Promise<RecoveryOutcome>;
}

function assertSameIdentity(row: QueryRecord, account: string, cpf: string): void {
  if (row.account !== account || row.cpf !== cpf ||
      (row.kind !== undefined && row.kind !== 'person')) {
    throw new Error('Historico inconsistente: a consulta nao corresponde a conta e ao CPF da CPI.');
  }
}

/**
 * Fase 4B: prepara o PDF a partir do historico da mesma conta.
 * - Sem historico: apenas indica necessidade de autorizacao, nunca envia POST.
 * - Com codigo: o chamador pode recuperar por GET; o retorno e conferido no historico.
 * - Nunca expoe CPF, codigo da API, caminho local ou resultado bruto no IPC.
 */
export async function prepareCpiPersonPdf(args: PrepareCpiPersonPdfArgs): Promise<CpiPersonPreparationResult> {
  const { ids, account, cpf, outputFolder, findLatest, recoverExisting } = args;
  if (!validateCpiRowId(ids) || !account.trim() || !isValidCpf(cpf)) {
    throw new Error('Identificacao CPI ou sessao Deskdata invalida.');
  }
  const result = (state: CpiPersonPreparationState, reused: boolean): CpiPersonPreparationResult =>
    ({ ...ids, state, reused });

  const latest = await findLatest(account, cpf, 'person');
  if (!latest) return result('requires_paid_authorization', false);
  assertSameIdentity(latest, account, cpf);
  if (!outputFolder) return result('folder_unconfigured', false);

  // PDF reutilizado somente quando registrado na consulta mais recente e validado no destino.
  if (latest.status === 'ready') {
    try {
      await findCpiPersonPdf(latest, cpf, outputFolder);
      return result('pdf_ready', true);
    } catch {
      // PDF ausente: somente recuperar via codigo existente, nunca um POST novo.
    }
  }

  if (!latest.queryCode) return result('manual_review', false);
  const recovered = await recoverExisting(latest);
  if (recovered.state === 'pending') return result('pending', true);

  const updated = await findLatest(account, cpf, 'person');
  if (!updated || updated.id !== latest.id) {
    throw new Error('Historico alterado durante a recuperacao; associacao CPI interrompida.');
  }
  assertSameIdentity(updated, account, cpf);
  if (updated.status !== 'ready') {
    throw new Error('A API informou conclusao, mas o historico nao confirmou o PDF.');
  }
  await findCpiPersonPdf(updated, cpf, outputFolder);
  return result('pdf_ready', true);
}

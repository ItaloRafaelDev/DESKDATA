import type { Frame, Page } from 'playwright-core';
import { CPI_PENDING_URL, readListingCount } from './pending-filter.ts';
import { inspectPendingPerson29Rows, validateCpiRowId, type CpiPendingRowId, type CpiPendingRowsInspection } from './pending-rows.ts';

const CPI_HOST = 'adm.cpicentral.com.br';

/** Confirma o retorno à listagem depois de uma resposta, sem consultar nem reabrir pesquisas. */
export function isPostSaveListingReady(
  total: number | null,
  inspection: CpiPendingRowsInspection,
  completed: CpiPendingRowId
): boolean {
  if (!validateCpiRowId(completed) || total === null || inspection.total !== total) return false;
  if (inspection.state !== 'mapped' && inspection.state !== 'empty') return false;
  return !inspection.rows.some(row => row.pesquisaId === completed.pesquisaId &&
    row.solicitacaoId === completed.solicitacaoId);
}

function isCpiFrame(frame: Frame): boolean {
  try { return new URL(frame.url()).hostname === CPI_HOST; } catch { return false; }
}

/**
 * A Shadowbox fecha sem necessariamente recarregar a listagem. Forçar apenas
 * o botão de LISTAGEM "Mostrar Tudo", já mapeado na CPI, e aguardar uma leitura
 * estável que não contenha a pesquisa concluída. Nunca disparar o botão Alterar.
 * Falha fechada se a CPI permanecer exibindo resultados antigos.
 */
export async function refreshPendingAfterConfirmedSave(
  page: Page,
  completed: CpiPendingRowId,
  timeoutMs = 20000
): Promise<void> {
  if (!validateCpiRowId(completed)) throw new Error('Identificadores da pesquisa concluída são inválidos.');
  const url = new URL(page.url());
  if (url.hostname !== CPI_HOST || url.pathname.toLowerCase() !== new URL(CPI_PENDING_URL).pathname.toLowerCase()) {
    throw new Error('Página de pesquisas aguardando não confirmada após fechar o modal CPI.');
  }
  await page.locator('#sb-container').waitFor({ state: 'hidden', timeout: 8000 });
  let showAll: import('playwright-core').Locator | null = null;
  const controlDeadline = Date.now() + 8000;
  while (Date.now() < controlDeadline && !showAll) {
    for (const frame of page.frames().filter(isCpiFrame)) {
      const options = frame.locator('[title="Mostrar Tudo"]');
      if (await options.count().catch(() => 0) !== 1) continue;
      if (await options.isVisible().catch(() => false)) { showAll = options; break; }
    }
    if (!showAll) await page.waitForTimeout(200);
  }
  if (!showAll) throw new Error('A listagem CPI não retornou após o fechamento da resposta.');
  await showAll.click({ timeout: 10000 });

  const deadline = Date.now() + timeoutMs;
  let previousSignature = '';
  let stableReads = 0;
  while (Date.now() < deadline) {
    // A CPI pode manter temporariamente o rodapé da listagem anterior.
    // Exigir leitura completa dos IDs, não apenas um total positivo.
    const total = await readListingCount(page, 700);
    if (total !== null) {
      const inspected = await inspectPendingPerson29Rows(page, total);
      if (isPostSaveListingReady(total, inspected, completed)) {
        const signature = `${total}|${inspected.rows.map(row => `${row.pesquisaId}:${row.solicitacaoId}`).sort().join('|')}`;
        stableReads = signature === previousSignature ? stableReads + 1 : 1;
        previousSignature = signature;
        if (stableReads >= 2) return;
      } else {
        stableReads = 0;
        previousSignature = '';
      }
    }
    await page.waitForTimeout(350);
  }
  throw new Error('A CPI não confirmou a atualização da listagem após responder. Requer verificação antes de processar outra pesquisa.');
}

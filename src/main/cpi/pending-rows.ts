import type { Frame, Page } from 'playwright-core';
import { CPI_PENDING_URL } from './pending-filter.ts';

/** Fase 3B: apenas metadados numéricos da listagem; nunca coleta CPF, nome ou chave. */
export interface CpiPendingRowId {
  pesquisaId: string;
  solicitacaoId: string;
}

export interface CpiPendingRowsInspection {
  state: 'empty' | 'mapped' | 'needs_mapping' | 'unconfirmed';
  total: number | null;
  visibleRows: number;
  rows: CpiPendingRowId[];
  framesInspected: number;
  message: string;
}

interface FrameRowsResult {
  candidateGrids: number;
  visibleRows: number;
  rows: CpiPendingRowId[];
  uncertainRows: number;
  actionButtons: number;
}

// Sem teto local de linhas (D1): vale o que a página da CPI exibe, limitado pelo total confirmado no rodapé.
const CPI_HOST = 'adm.cpicentral.com.br';

export function isCpiNumericIdentifier(value: string): boolean {
  return /^[1-9]\d{3,11}$/.test(value.trim());
}

export function validateCpiRowId(value: unknown): CpiPendingRowId | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<CpiPendingRowId>;
  if (typeof item.pesquisaId !== 'string' || typeof item.solicitacaoId !== 'string') return null;
  if (!isCpiNumericIdentifier(item.pesquisaId) || !isCpiNumericIdentifier(item.solicitacaoId)) return null;
  return { pesquisaId: item.pesquisaId.trim(), solicitacaoId: item.solicitacaoId.trim() };
}

/**
 * Funciona somente com o filtro 29 já aplicado e com total do rodapé confirmado.
 * Consegue inspecionar a página corrente sem alterar a CPI ou acessar detalhes.
 * Em caso de mapeamento ambíguo, não devolve IDs parcialmente confiáveis.
 */
export async function inspectPendingPerson29Rows(page: Page, expectedTotal: number | null): Promise<CpiPendingRowsInspection> {
  if (expectedTotal === null || !Number.isSafeInteger(expectedTotal) || expectedTotal < 0) {
    return { state: 'unconfirmed', total: null, visibleRows: 0, rows: [], framesInspected: 0,
      message: 'O total da CPI não foi confirmado; leitura de linhas bloqueada.' };
  }
  if (new URL(page.url()).hostname !== CPI_HOST ||
    new URL(page.url()).pathname.toLowerCase() !== new URL(CPI_PENDING_URL).pathname.toLowerCase()) {
    throw new Error('A leitura de linhas exige a página de pesquisas aguardando da CPI.');
  }
  if (expectedTotal === 0) {
    return { state: 'empty', total: 0, visibleRows: 0, rows: [], framesInspected: 0,
      message: 'Nenhuma solicitação pendente no filtro 29.' };
  }

  let framesInspected = 0;
  const candidates: FrameRowsResult[] = [];
  for (const frame of page.frames()) {
    if (!isOfficialCpiFrame(frame)) continue;
    framesInspected++;
    try {
      const result = await frame.evaluate((): FrameRowsResult => {
        const clean = (text: string): string => text.normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
        const id = (text: string): string | null => {
          const trimmed = text.trim();
          return /^[1-9]\d{3,11}$/.test(trimmed) ? trimmed : null;
        };
        const ownCells = (row: Element): Element[] => Array.from(row.children).filter(child =>
          child.matches('th, td, .cell, [role="cell"], [role="gridcell"], [role="columnheader"]'));
        const cellText = (cell: Element): string => (cell as HTMLElement).innerText ?? cell.textContent ?? '';
        const results: FrameRowsResult = { candidateGrids: 0, visibleRows: 0, rows: [], uncertainRows: 0, actionButtons: 0 };

        const seen = new Set<string>();

        // CPI real: a acao Responder / Atualizar carrega os dois identificadores
        // no proprio atributo onclick. Apenas LER a string; nunca executar codigo.
        // Este vinculo evita depender de cabecalhos ou posicoes da tabela legada.
        const actions = Array.from(document.querySelectorAll('[title="Responder / Atualizar"][onclick]'));
        if (actions.length) {
          results.candidateGrids = 1;
          results.actionButtons = actions.length;
          for (const action of actions) {
            const row = action.closest('.row');
            const onclick = action.getAttribute('onclick') ?? '';
            if (!row || !row.closest('.table') ||
                !/openShadowbox\s*\(/i.test(onclick) ||
                !/\/zpersEspecial\/pesquisas\/upd_cad\/mod_tt_pesq_upd\.aspx\?/i.test(onclick)) {
              results.uncertainRows++;
              continue;
            }
            const sol = onclick.match(/(?:[?&])id_sol=([1-9]\d{3,11})(?=[&'"\s])/i)?.[1] ?? null;
            // O nome id_pesq_tipo e o parametro que o portal usa para o
            // NUMERO DA PESQUISA nesta acao (e nao o codigo de modalidade 29).
            const pesq = onclick.match(/(?:[?&])id_pesq_tipo=([1-9]\d{3,11})(?=[&'"\s])/i)?.[1] ?? null;
            const cells = ownCells(row);
            const texts = cells.map(cell => clean(cellText(cell)));
            const correctType = texts.some(value => value === 'PROCESSOS JUDICIAIS CRIMINAL FORUM NACIONAL CPF');
            const idsMatchCells = !!pesq && !!sol &&
              cells.some(cell => id(cellText(cell)) === pesq) &&
              cells.some(cell => id(cellText(cell)) === sol);
            if (!correctType || !idsMatchCells || !pesq || !sol) {
              results.uncertainRows++;
              continue;
            }
            results.visibleRows++;
            const key = `${pesq}:${sol}`;
            if (seen.has(key)) {
              results.uncertainRows++;
              continue;
            }
            seen.add(key);
            results.rows.push({ pesquisaId: pesq, solicitacaoId: sol });
          }
          return results;
        }
        const roots = document.querySelectorAll('table, .table, .grid, [role="grid"]');

        for (const root of roots) {
          const gridRows = Array.from(root.querySelectorAll('tr, .row, [role="row"]'));
          const header = gridRows.find(row => {
            const labels = ownCells(row).map(cell => clean(cellText(cell)));
            return labels.some(label => label.includes('ID SOLICIT')) &&
              labels.some(label => label.includes('TIPO PESQUISA'));
          });
          if (!header) continue;
          results.candidateGrids++;
          const labels = ownCells(header).map(cell => clean(cellText(cell)));
          const solicitacaoIndex = labels.findIndex(label => label.includes('ID SOLICIT'));
          const tipoIndex = labels.findIndex(label => label.includes('TIPO PESQUISA'));
          const pesquisaIndex = labels.findIndex(label => label.includes('ID PESQUISA') || label.includes('N PESQUISA'));
          // No DOM real o ID da pesquisa ocupa uma coluna sem título, após um checkbox.
          // Não presumir coluna zero: somente um identificador numérico anterior à solicitação é aceito.
          const firstIndex = pesquisaIndex;

          for (const row of gridRows.slice(gridRows.indexOf(header) + 1)) {
            const cells = ownCells(row);
            if (!cells.length || solicitacaoIndex >= cells.length || tipoIndex >= cells.length) continue;
            const tipo = clean(cellText(cells[tipoIndex]));
            // Não lê nomes/CPF/chave, apenas confirma a coluna de modalidade.
            if (!tipo.includes('PROCESSOS JUDICIAIS CRIMINAL FORUM NACIONAL CPF')) {
              if (id(cellText(cells[solicitacaoIndex]))) results.uncertainRows++;
              continue;
            }
            results.visibleRows++;
            const precedingIds = firstIndex >= 0
              ? [id(cellText(cells[firstIndex]))].filter((value): value is string => value !== null)
              : cells.slice(0, solicitacaoIndex).map(cell => id(cellText(cell))).filter((value): value is string => value !== null);
            const pesquisaId = precedingIds.length === 1 ? precedingIds[0] : null;
            const solicitacaoId = id(cellText(cells[solicitacaoIndex]));
            if (!pesquisaId || !solicitacaoId) { results.uncertainRows++; continue; }
            const key = `${pesquisaId}:${solicitacaoId}`;
            if (!seen.has(key)) {
              seen.add(key); results.rows.push({ pesquisaId, solicitacaoId });
            }
          }
        }
        return results;
      });
      if (result.candidateGrids) candidates.push(result);
    } catch { /* frame em navegação: o resultado deve permanecer não confirmado */ }
  }
  // O mesmo grid pode aparecer em elementos contêineres aninhados. Um mapeamento
  // completo só pode ser aceito quando existe uma única interpretação consistente.
  const normalized = candidates.filter(c => c.visibleRows > 0 || c.uncertainRows > 0);
  if (!normalized.length) {
    return { state: 'needs_mapping', total: expectedTotal, visibleRows: 0, rows: [], framesInspected,
      message: 'A CPI retornou solicitações, mas nenhum botão de resposta ou cabeçalho de tabela pôde ser associado com segurança às linhas.' };
  }
  const selected = normalized.sort((a,b) => b.rows.length - a.rows.length)[0];
  const signatures = new Set(normalized.map(c => c.rows.map(row => `${row.pesquisaId}:${row.solicitacaoId}`).sort().join('|')));
  if (signatures.size !== 1 || selected.uncertainRows || selected.visibleRows !== selected.rows.length ||
      selected.rows.length === 0 || selected.rows.length > expectedTotal ||
      selected.rows.some(row => !validateCpiRowId(row))) {
    return { state: 'needs_mapping', total: expectedTotal, visibleRows: selected.visibleRows, rows: [], framesInspected,
      message: selected.actionButtons > 0
      ? `Localizados ${selected.actionButtons} controles Responder / Atualizar, mas nem todos passaram na conferência de IDs e modalidade. Nenhuma solicitação foi liberada.`
      : 'Os identificadores das linhas não foram confirmados. É necessário validar o DOM da listagem antes de continuar.' };
  }
  return { state: 'mapped', total: expectedTotal, visibleRows: selected.rows.length, rows: selected.rows,
    framesInspected, message: expectedTotal > selected.rows.length
      ? 'Identificadores da página visível detectados. Existem outras páginas ainda não mapeadas.'
      : 'Identificadores numéricos detectados. É necessária validação no portal antes de abrir as solicitações.' };
}

function isOfficialCpiFrame(frame: Frame): boolean {
  try { return new URL(frame.url()).hostname === CPI_HOST; } catch { return false; }
}

import type { CpiDetailDomSnapshot } from './pending-details.ts';

/** Evidências mínimas para reconhecer uma resposta CPI persistida na operação atual. */
export interface CpiSavedResponseEvidence {
  matchingIds: boolean;
  statusRespondida: boolean;
  matchingResult: boolean;
  /** Pesquisador/Fonte exibido como "Desk Data". */
  matchingSource: boolean;
  hasResponseTimestamp: boolean;
  /**
   * A linha "Em arquivo" exibe exatamente "Documento PDF". É uma INDICAÇÃO da interface, não prova de que o
   * arquivo existe, está íntegro ou é o PDF enviado: o portal não expõe contrato observado (identificador,
   * nome, hash ou tamanho) verificável só por leitura. Ausente ou ambígua, a conclusão é bloqueada.
   */
  pdfAttachmentIndicated: boolean;
  editableUploadPresent: boolean;
  serverErrorVisible: boolean;
  auxiliary404Observed: boolean;
}

export function hasConfirmedSavedCpiResponse(evidence: CpiSavedResponseEvidence): boolean {
  return evidence.matchingIds && evidence.statusRespondida && evidence.matchingResult &&
    evidence.matchingSource && evidence.hasResponseTimestamp && evidence.pdfAttachmentIndicated &&
    !evidence.editableUploadPresent && !evidence.serverErrorVisible;
}

/**
 * O portal pode exibir erro HTTP 404 em /cpi_api_request.aspx dentro do
 * histórico enquanto o FORMULARIO PRINCIPAL já indica resposta persistida.
 * Isso é um aviso de integração externa, NÃO uma prova de falha no POST de
 * Alterar. Qualquer outra tela de erro permanece bloqueante.
 * O resultado só será considerado persistido em conjunto com os campos
 * da resposta, o confirm do navegador e o POST do formulário com sucesso.
 */
export function classifyCpiVisibleServerError(value: string): { blocking: boolean; auxiliary404: boolean } {
  const text = value.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ');
  const patterns = /ERRO DE SERVIDOR NO APLICATIVO|NAO E POSSIVEL ENCONTRAR O RECURSO|SERVER ERROR IN/gi;
  const occurrences = [...text.matchAll(patterns)].length;
  if (!occurrences) return { blocking: false, auxiliary404: false };
  // A mensagem observada tem DOIS trechos indicadores para o mesmo 404.
  // Em caso de outra falha HTTP adicional, não ignorar erros desconhecidos.
  const auxiliary404 = /(?:404;404;|HTTP\s*404|\b404\b)/i.test(text) &&
    CPI_AUXILIARY_URL_TEXT.test(text) && occurrences <= 2;
  return { blocking: !auxiliary404, auxiliary404 };
}

/**
 * "URL solicitada: /cpi_api_request.aspx" com o caminho exato: aceita só query string e pontuação final seguida de
 * espaço/fim. Rejeita caminhos semelhantes (`.aspx.bak`, `.aspx/x`, `/outro/cpi_api_request.aspx`).
 */
export const CPI_AUXILIARY_URL_TEXT = /URL SOLICITADA\s*:\s*\/?CPI_API_REQUEST\.ASPX(?:\?\S*)?(?=[.,;"']?(?:\s|$))/;

const CPI_AUXILIARY_ORIGIN = 'https://adm.cpicentral.com.br';
const CPI_AUXILIARY_PATH = '/cpi_api_request.aspx';
/**
 * Recurso auxiliar do portal (integração externa); não faz parte do formulário de resposta.
 * Exige HTTPS, o host oficial da CPI (sem porta nem credenciais) e o caminho exato.
 */
export function isCpiAuxiliaryResource(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === CPI_AUXILIARY_ORIGIN && !parsed.username && !parsed.password &&
      parsed.pathname.toLowerCase() === CPI_AUXILIARY_PATH;
  } catch { return false; }
}

/**
 * Classifica uma resposta HTTP observada durante o salvamento ou a conferência, nesta ordem:
 * 1. `main_failed`: o documento principal (POST de Alterar ou navegação do frame do formulário) com HTTP ≥ 400.
 *    Prevalece sobre qualquer exceção: nem o 404 nem a URL auxiliar viram aviso no documento principal.
 * 2. `auxiliary_404`: 404 do recurso auxiliar exato (origem e caminho conferidos), fora do documento principal.
 * 3. `auxiliary_failed`: o recurso auxiliar exato com outro status de erro (condição não observada; não é mascarada).
 * 4. `ignored`: sucesso, ou falha de recurso secundário (imagem, script, outro frame ou origem).
 */
export function classifyCpiHttpResponse(response: { url: string; status: number; mainDocument: boolean }): 'main_failed' | 'auxiliary_404' | 'auxiliary_failed' | 'ignored' {
  if (!Number.isInteger(response.status) || response.status < 400) return 'ignored';
  if (response.mainDocument) return 'main_failed';
  if (isCpiAuxiliaryResource(response.url)) return response.status === 404 ? 'auxiliary_404' : 'auxiliary_failed';
  return 'ignored';
}

const norm = (value: string): string => value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();

/** Evidências da resposta somente leitura (IDs já conferidos pelo chamador no mesmo documento). */
export function savedResponseEvidenceFromDom(dom: CpiDetailDomSnapshot, classification: 'restrictions' | 'information'): CpiSavedResponseEvidence {
  const result = norm(dom.savedResult);
  const timestamp = dom.responseTimestamp.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s|$)/);
  const day = Number(timestamp?.[1]), month = Number(timestamp?.[2]), year = Number(timestamp?.[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  const validDate = !!timestamp && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  const errors = classifyCpiVisibleServerError(dom.errorSignals);
  return {
    matchingIds: true, statusRespondida: norm(dom.savedStatus) === 'RESPONDIDA',
    matchingResult: classification === 'restrictions' ? /^SIM\s*,?\s*CONSTA RESTRICOES$/.test(result) : result === 'HA INFORMACOES',
    matchingSource: norm(dom.savedSource) === 'DESK DATA', hasResponseTimestamp: validDate,
    pdfAttachmentIndicated: norm(dom.pdfDocument) === 'DOCUMENTO PDF', editableUploadPresent: dom.editableUploadPresent,
    serverErrorVisible: errors.blocking || dom.businessErrorVisible, auxiliary404Observed: errors.auxiliary404
  };
}

/**
 * Persistência comprovada por leitura independente (GET) do detalhe da pesquisa.
 * - `confirmed`: IDs, Status Respondida, classificação, data, fonte Desk Data e Documento PDF presentes.
 * - `absent`: documento lido e correlacionado, mas a resposta salva está incompleta (ex.: sem Documento PDF).
 * - `unavailable`: não foi possível ler ou correlacionar o documento, ou há erro bloqueante visível.
 * Só `confirmed` conclui a pesquisa; os demais exigem verificação manual, sem reenvio.
 */
export type CpiPersistenceVerdict = 'confirmed' | 'absent' | 'unavailable';
export function judgeSavedCpiResponse(evidence: CpiSavedResponseEvidence | null): CpiPersistenceVerdict {
  if (!evidence || !evidence.matchingIds || evidence.serverErrorVisible) return 'unavailable';
  return hasConfirmedSavedCpiResponse(evidence) ? 'confirmed' : 'absent';
}

/**
 * Resultado da finalização depois de um envio aceito pelo formulário. A persistência é decidida apenas pela
 * leitura independente; modal e listagem são efeitos visuais e nunca alteram esse veredito.
 */
export interface CpiFinalizeReport {
  persistence: CpiPersistenceVerdict;
  auxiliary404: boolean;
  /** `auto_closed`: o portal já havia fechado; `not_attempted`: persistência não comprovada, modal preservado. */
  modal: 'auto_closed' | 'closed' | 'close_failed' | 'not_attempted';
  listing: 'refreshed' | 'stale' | 'not_attempted';
  /**
   * Liberação operacional do navegador, separada da persistência: `false` quando a janela da pesquisa continua
   * aberta (ou o estado não pôde ser lido). Nesse caso o navegador recusa abrir outra pesquisa até o modal sumir.
   */
  browserReleased: boolean;
}

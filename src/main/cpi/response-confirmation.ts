/** Evidências mínimas para reconhecer uma resposta CPI persistida na operação atual. */
export interface CpiSavedResponseEvidence {
  matchingIds: boolean;
  statusRespondida: boolean;
  matchingResult: boolean;
  hasResponseTimestamp: boolean;
  hasPdfDocument: boolean;
  editableUploadPresent: boolean;
  serverErrorVisible: boolean;
  auxiliary404Observed: boolean;
}

export function hasConfirmedSavedCpiResponse(evidence: CpiSavedResponseEvidence): boolean {
  return evidence.matchingIds && evidence.statusRespondida && evidence.matchingResult &&
    evidence.hasResponseTimestamp && evidence.hasPdfDocument &&
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
  const text = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ');
  const patterns = /ERRO DE SERVIDOR NO APLICATIVO|NAO E POSSIVEL ENCONTRAR O RECURSO|SERVER ERROR IN/gi;
  const occurrences = [...text.matchAll(patterns)].length;
  if (!occurrences) return { blocking: false, auxiliary404: false };
  // A mensagem observada tem DOIS trechos indicadores para o mesmo 404.
  // Em caso de outra falha HTTP adicional, não ignorar erros desconhecidos.
  const auxiliary404 = /(?:404;404;|HTTP\s*404|\b404\b)/i.test(text) &&
    /URL SOLICITADA\s*:\s*\/?CPI_API_REQUEST\.ASPX\b/.test(text) && occurrences <= 2;
  return { blocking: !auxiliary404, auxiliary404 };
}

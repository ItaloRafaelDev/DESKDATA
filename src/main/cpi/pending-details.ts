import { isValidCpf, cpfDigits } from '../../shared/cpf.ts';
import { validateCpiRowId, type CpiPendingRowId } from './pending-rows.ts';

/** Leitura local de uma solicitação; o CPF completo nunca é enviado à interface nem aos logs. */
export interface CpiPendingPersonDetail {
  pesquisaId: string;
  solicitacaoId: string;
  cpfValidated: true;
  cpfMasked: string;
  status: 'aguardando';
}

export interface CpiInternalPersonDetail {
  publicDetail: CpiPendingPersonDetail;
  cpf: string;
}

export interface CpiRawPersonDetails {
  solicitacaoHeading: string;
  pesquisaHeading: string;
  pesquisaType: string;
  cpfText: string;
  status: string;
}

/**
 * Aceita apenas variantes textuais dos titulos da CPI, nunca IDs parciais.
 * Ex.: "Dados Solicitação 123456" e "Dados da Solicitação: 123456".
 */
export function parseCpiDetailHeadingId(text: string, kind: 'solicitacao' | 'pesquisa'): string | null {
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ').trim().toUpperCase();
  const heading = kind === 'solicitacao' ? 'DADOS(?: DA)? SOLICITACAO' : 'DADOS DA PESQUISA';
  const match = normalized.match(new RegExp(`^${heading}(?:\\s*[-:#]\\s*|\\s+)([1-9]\\d{3,11})$`));
  return match?.[1] ?? null;
}

/**
 * Consolida evidencias de titulo de um mesmo iframe CPI. A primeira origem sao
 * os elementos h1/h2/h3; a segunda, titulos visiveis extraidos do corpo.
 * Se houver IDs diferentes, falha fechado em vez de escolher um arbitrariamente.
 */
export function resolveCpiDetailHeadings(candidates: readonly string[]):
  Pick<CpiRawPersonDetails, 'solicitacaoHeading' | 'pesquisaHeading'> | null {
  const find = (kind: 'solicitacao' | 'pesquisa'): string | null => {
    const ids = new Set(candidates.map(value => parseCpiDetailHeadingId(value, kind))
      .filter((value): value is string => value !== null));
    return ids.size === 1 ? [...ids][0] : null;
  };
  const solicitacaoId = find('solicitacao');
  const pesquisaId = find('pesquisa');
  return solicitacaoId && pesquisaId
    ? {solicitacaoHeading: `Dados Solicitação ${solicitacaoId}`,
      pesquisaHeading: `Dados da Pesquisa - ${pesquisaId}`}
    : null;
}

/** Falha fechada: só aceita registro, modalidade e status exatamente esperados. */
export function validateCpiPersonDetails(ids: CpiPendingRowId, raw: CpiRawPersonDetails): CpiInternalPersonDetail {
  if (!validateCpiRowId(ids)) throw new Error('Identificadores CPI inválidos.');
  const solicitacaoId = parseCpiDetailHeadingId(raw.solicitacaoHeading, 'solicitacao');
  const pesquisaId = parseCpiDetailHeadingId(raw.pesquisaHeading, 'pesquisa');
  if (!solicitacaoId || !pesquisaId) {
    throw new Error('A CPI apresentou um cabeçalho de solicitação ou pesquisa em formato não reconhecido. Nenhuma consulta foi iniciada.');
  }
  if (solicitacaoId !== ids.solicitacaoId || pesquisaId !== ids.pesquisaId) {
    throw new Error(`A janela CPI aberta não corresponde à seleção: esperado pesquisa ${ids.pesquisaId}/solicitação ${ids.solicitacaoId}, exibido pesquisa ${pesquisaId}/solicitação ${solicitacaoId}. Nenhuma consulta ou envio foi feito.`);
  }
  const normalize = (value: string): string => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
  if (normalize(raw.pesquisaType) !== 'PROCESSOS JUDICIAIS CRIMINAL FORUM NACIONAL CPF') {
    throw new Error('A modalidade do formulário não corresponde à pesquisa CPI 29.');
  }
  if (normalize(raw.status) !== 'AGUARDANDO PESQUISA') {
    throw new Error('A pesquisa já não está aguardando atendimento. Nenhuma operação foi executada.');
  }
  const cpf = cpfDigits(raw.cpfText);
  if (!isValidCpf(cpf)) throw new Error('CPF ausente ou inválido no formulário da CPI.');
  return {
    cpf,
    publicDetail: {
      pesquisaId: ids.pesquisaId,
      solicitacaoId: ids.solicitacaoId,
      cpfValidated: true,
      cpfMasked: '***.***.***-**',
      status: 'aguardando'
    }
  };
}

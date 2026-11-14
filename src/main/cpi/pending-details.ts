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

export interface CpiDetailDomSnapshot {
  titles:string[];
  cpfText:string;
  pesquisaType:string;
  status:string;
  savedStatus:string;
  savedResult:string;
  savedSource:string;
  responseTimestamp:string;
  pdfDocument:string;
  editableUploadPresent:boolean;
  errorSignals:string;
  businessErrorVisible:boolean;
}

/** Executada no frame: somente campos conhecidos, nunca o corpo completo cruza a fronteira. */
export function readCpiDetailDom():CpiDetailDomSnapshot {
  const norm=(text:string)=>text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim().toUpperCase();
  const titles=Array.from(document.querySelectorAll('h1,h2,h3,.mt'))
    .map(node=>(node as HTMLElement).innerText?.trim()??node.textContent?.trim()??'').filter(Boolean).slice(0,30);
  const visibleText=(document.body?.innerText??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
  for(const line of visibleText.split(/\r?\n/)){
    const sol=line.trim().match(/^DADOS(?: DA)? SOLICITACAO\s*(?:[-:#]\s*)?([1-9]\d{3,11})$/);
    const pesq=line.trim().match(/^DADOS DA PESQUISA\s*(?:[-:#]\s*)?([1-9]\d{3,11})$/);
    if(sol)titles.push(`Dados Solicitação ${sol[1]}`);
    if(pesq)titles.push(`Dados da Pesquisa - ${pesq[1]}`);
  }
  const fields=new Map<string,string[]>();
  for(const row of document.querySelectorAll('.row')){
    const cells=Array.from(row.children).filter(node=>node.matches('.cell,td'));
    for(let i=0;i<cells.length-1;i++){
      const label=norm(cells[i].textContent??'');
      if(!label.endsWith(':'))continue;
      const values=fields.get(label)??[];
      values.push(((cells[i+1] as HTMLElement).innerText??cells[i+1].textContent??'').trim());
      fields.set(label,values);
    }
  }
  const unique=(label:string)=>{const values=fields.get(label);return values?.length===1?values[0]:'';};
  let cpfText=unique('CPF:'),pesquisaType=unique('PESQUISA:');
  if(!cpfText&&!fields.has('CPF:')){
    const matches=[...visibleText.matchAll(/\bCPF\s*:\s*(\d{3}\.\d{3}\.\d{3}-\d{2})\b/g)];
    if(matches.length===1)cpfText=matches[0][1];
  }
  if(!pesquisaType&&/\bPESQUISA\s*:\s*PROCESSOS JUDICIAIS CRIMINAL FORUM NACIONAL CPF\b/.test(visibleText))pesquisaType='PROCESSOS JUDICIAIS CRIMINAL FORUM NACIONAL CPF';
  const selected=Array.from(document.querySelectorAll('select')).map(el=>el.selectedOptions[0]?.textContent?.trim()??'')
    .find(text=>/aguardando pesquisa|respondida/i.test(text));
  const signals=[...visibleText.matchAll(/ERRO DE SERVIDOR NO APLICATIVO|NAO E POSSIVEL ENCONTRAR O RECURSO|SERVER ERROR IN/g)].map(match=>match[0]);
  if(/404;404;|HTTP\s*404|\b404\b/.test(visibleText))signals.push('404;404;');
  // Mesmo padrão de CPI_AUXILIARY_URL_TEXT (response-confirmation.ts); inline porque roda serializado no frame.
  if(/URL SOLICITADA\s*:\s*\/?CPI_API_REQUEST\.ASPX(?:\?\S*)?(?=[.,;"']?(?:\s|$))/.test(visibleText))signals.push('URL SOLICITADA: /CPI_API_REQUEST.ASPX');
  return {titles,cpfText,pesquisaType,status:selected??unique('STATUS:'),savedStatus:unique('STATUS:'),
    savedResult:unique('RESULTADO:'),savedSource:unique('PESQUISADOR/FONTE:'),responseTimestamp:unique('RESPONDIDA EM:'),pdfDocument:unique('EM ARQUIVO:'),
    editableUploadPresent:!!document.querySelector('input[type="file"]'),errorSignals:signals.join(' '),
    businessErrorVisible:/(?:ERRO|FALHA)\s+(?:AO|NO SALVAMENTO)|NAO FOI POSSIVEL|NAO AUTORIZADO|DADOS INVALIDOS/.test(norm(visibleText))};
}

export function matchesCpiDetailHeadings(ids:CpiPendingRowId,headings:Pick<CpiRawPersonDetails,'solicitacaoHeading'|'pesquisaHeading'>):boolean {
  return parseCpiDetailHeadingId(headings.solicitacaoHeading,'solicitacao')===ids.solicitacaoId &&
    parseCpiDetailHeadingId(headings.pesquisaHeading,'pesquisa')===ids.pesquisaId;
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

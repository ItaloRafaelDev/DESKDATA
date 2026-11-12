/**
 * Classes de falha do FULL AUTO (D1). A classificação usa somente o texto fixo das mensagens
 * do aplicativo e o nome do erro; nada aqui é gravado em log com conteúdo da consulta.
 * - Parada imediata: sessão CPI ou Deskdata, saldo/autorização, layout do portal não reconhecido,
 *   fila CPI indisponível e troca de conta.
 * - Demais classes: o item vai para revisão e o agente segue; 3 falhas consecutivas da mesma classe pausam.
 */
export const CPI_FAILURE_KINDS=['cpi_session','deskdata_session','balance','portal_layout','storage','account_changed',
  'timeout','network','submit_unverified','item_data','unknown'] as const;
export type CpiFailureKind=typeof CPI_FAILURE_KINDS[number];
export const CPI_IMMEDIATE_STOP:ReadonlySet<CpiFailureKind>=new Set<CpiFailureKind>(['cpi_session','deskdata_session','balance','portal_layout','storage','account_changed']);
export const CPI_FAILURE_STREAK_LIMIT=3;

export const CPI_FAILURE_LABELS:Record<CpiFailureKind,string>={
  cpi_session:'sessão CPI indisponível ou expirada',deskdata_session:'sessão Deskdata expirada ou sem autorização',
  balance:'saldo ou autorização Deskdata insuficiente',portal_layout:'layout do portal CPI não reconhecido',
  storage:'fila CPI protegida indisponível',account_changed:'conta Deskdata alterada durante o processamento',
  timeout:'tempo limite excedido',network:'falha de rede',submit_unverified:'envio CPI sem confirmação',
  item_data:'dados da solicitação inconsistentes',unknown:'falha não classificada'
};

const RULES:[CpiFailureKind,RegExp][]=[
  ['storage',/fila cpi|protecao windows indisponivel/],
  ['account_changed',/conta deskdata alterada/],
  ['balance',/saldo|creditos insuficientes|autorize novas consultas|autorizacao deskdata/],
  ['deskdata_session',/sessao (nao autenticada|expirada)|credenciais invalidas|entre novamente|acesso nao autorizado/],
  ['cpi_session',/abra (primeiro|e autentique)|sessao cpi|dominio administrativo|redirecionamento inesperado/],
  ['portal_layout',/reconhecid|controle esperado nao encontrado|controle de filtro|selecao do tipo|tipos cpi|tipo 29|total nao confirmado|listagem nao confirmad|identificadores da listagem|nao foi possivel vincular de maneira unica|nao identificado de maneira unica/],
  ['timeout',/tempo limite|timeout|excedeu/],
  ['network',/falha de rede|net::|econn|enotfound|fetch failed|servico deskdata indisponivel/],
  ['item_data',/cpf|identidade|historico|corresponde|nao esta aguardando/]
];
const plain=(text:string):string=>text.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();

type ErrorLike={name?:unknown;message:string;cause?:unknown};
// Reconhecimento estrutural (não `instanceof`): erros podem vir de outro realm (frames, VM de testes).
const errorLike=(value:unknown):value is ErrorLike=>!!value&&typeof value==='object'&&typeof (value as ErrorLike).message==='string';
function classifyOne(error:unknown):CpiFailureKind {
  if(!errorLike(error))return 'unknown';
  if(error.name==='TimeoutError')return 'timeout';
  const message=plain(error.message);
  return RULES.find(([,pattern])=>pattern.test(message))?.[0]??'unknown';
}
/** Percorre a cadeia `cause` (no máximo 5 níveis): a primeira classe reconhecida prevalece. */
export function classifyCpiError(error:unknown):CpiFailureKind {
  let current:unknown=error;
  for(let depth=0;depth<5&&current;depth++){
    const kind=classifyOne(current);
    if(kind!=='unknown')return kind;
    current=errorLike(current)?current.cause:undefined;
  }
  return 'unknown';
}

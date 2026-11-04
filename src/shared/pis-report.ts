import { cpfDigits, isValidCpf } from './cpf.ts';
import { formatCpfOrCnpj, formatDatePtBr, translateEnum } from './localization.ts';

export interface PisRecord {
  name: string;
  gender: string;
  birthdate: string;
  age: string;
  cpf: string;
  taxStatus: string;
  fiscalRegion: string;
  registrationDate: string;
  pis: string;
}
function object(value:unknown):Record<string,unknown>|null {
  return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
}
function word(value:unknown):string {
  if(typeof value==='number' && Number.isFinite(value))return String(value);
  return typeof value==='string'&&value.trim()?value.trim():'Não informado';
}
function encodeHtml(value:unknown):string {
  return String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
export class PisNotAvailableError extends Error {
  constructor() {super('A Deskdata não disponibilizou o número do PIS nesta consulta. Nenhum PDF será gerado.');this.name='PisNotAvailableError';}
}
function pisFormat(value:unknown):string|null {
  if(typeof value!=='string'&&typeof value!=='number')return null;
  const digits=String(value).replace(/\D/g,'');
  if(!/^\d{11}$/.test(digits))return null;
  return digits.replace(/^(\d{3})(\d{5})(\d{2})(\d)$/,'$1.$2.$3-$4');
}
/** Basic da Deskdata: documento previdenciário em social_security.number.
 * A identificação comercial exata (PIS/NIS/NIT) deve ser conferida com o provedor. */
export function normalizePisResult(payload:unknown,requestedCpf:string):PisRecord {
  if(!isValidCpf(requestedCpf))throw new Error('CPF informado é inválido.');
  const envelope=object(payload);
  if(Number(object(envelope?.status)?.code)!==4000)throw new Error('Resposta de consulta sem confirmação de sucesso.');
  const basic=object(object(envelope?.data)?.basic);
  if(!basic||basic.error)throw new Error('Dataset basic ausente ou com falha específica.');
  const tax=object(basic.tax_id)??{};
  const returnedCpf=String(tax.number??basic.cpf??'').replace(/\D/g,'');
  if(returnedCpf && returnedCpf!==cpfDigits(requestedCpf))throw new Error('O CPF retornado não corresponde ao CPF consultado.');
  const social=object(basic.social_security)??{};
  const number=social.number;
  if(number===null || number===undefined || (typeof number==='string' && !number.trim()))throw new PisNotAvailableError();
  const pis=pisFormat(number);
  if(!pis)throw new Error('Número previdenciário retornado em formato inválido. Nenhum PDF será gerado.');
  const nestedName=object(basic.name);
  const name=word(nestedName?.full_name ?? basic.full_name ?? (typeof basic.name==='string'?basic.name:undefined));
  return {
    name,gender:translateEnum(basic.gender),birthdate:formatDatePtBr(basic.birthdate??basic.birth_date),
    age:word(basic.age),cpf:formatCpfOrCnpj(cpfDigits(requestedCpf)),
    taxStatus:translateEnum(tax.status),fiscalRegion:word(tax.fiscal_region),
    registrationDate:formatDatePtBr(tax.registration_date),pis
  };
}

/** Relatório deliberadamente semelhante ao modelo A4 fornecido: somente nove linhas, sem logomarca ou fonte. */
export function renderPisPdfHtml(record:PisRecord):string {
  const rows:[string,string][]=[
    ['Nome',record.name],['Gênero',record.gender],['Nascimento',record.birthdate],['Idade',record.age],
    ['CPF',record.cpf],['Situação do CPF',record.taxStatus],['Região fiscal',record.fiscalRegion],
    ['Data de registro do CPF',record.registrationDate],['PIS',record.pis]
  ];
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Consulta PIS</title><style>
    @page{size:A4;margin:0}*{box-sizing:border-box}
    html,body{margin:0;padding:0;background:white;font-family:Arial,'Segoe UI',sans-serif;color:#262c35;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .sheet{padding:29mm 25mm 20mm;min-height:297mm}
    dl{margin:0;display:grid;grid-template-columns:49mm minmax(0,1fr);column-gap:8mm;row-gap:6mm;align-items:baseline;font-size:11pt;line-height:1.32}
    dt{font-weight:700;white-space:nowrap}dd{margin:0;overflow-wrap:anywhere}
  </style></head><body><main class="sheet"><dl>${rows.map(([label,value])=>`<dt>${encodeHtml(label)}</dt><dd>${encodeHtml(value)}</dd>`).join('')}</dl></main></body></html>`;
}

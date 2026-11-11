import { formatCnpj } from './cnpj.ts';
import { companyActivityList, formatCompanyActivity, formatCompanyValue } from './company-format.ts';
import { formatCaseNumber, formatCpfOrCnpj, formatDatePtBr, formatAddressRecord, formatPhoneRecord, translateEnum } from './localization.ts';
import { normalizeJudicialDataset } from './normalizer.ts';
import { resolveJudicialCompetence } from './judicial.ts';
export const COMPANY_DATASETS=['basic','phones','addresses','emails','relationships','lawsuits'] as const;
export type CompanyDataset=(typeof COMPANY_DATASETS)[number];
export type CompanyRecord={basic:Record<string,unknown>; phones:unknown[];addresses:unknown[];emails:unknown[];relationships:unknown[];lawsuits:unknown[]};
function obj(v:unknown):Record<string,unknown>|null{return v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;}
function get(o:Record<string,unknown>,...keys:string[]):unknown{for(const k of keys){const v=o[k];if(v!==null&&v!==undefined&&v!=='')return v;}return undefined;}
function esc(v:unknown):string{return formatCompanyValue(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function text(v:unknown):string{return formatCompanyValue(v);}
function list(data:Record<string,unknown>,key:CompanyDataset):unknown[]{
 if(key==='lawsuits')return normalizeJudicialDataset(data[key]).items;
 const value=obj(data[key]);if(!value)throw new Error(`Dataset ${key} não retornou objeto válido.`);
 if(value.error||obj(value.status)?.code && ![4000,2000].includes(Number(obj(value.status)?.code)))throw new Error(`Dataset ${key} retornou erro específico.`);
 if(Array.isArray(value.items))return value.items;
 if(value.total===0)return [];
 throw new Error(`Dataset ${key}: items ausente ou inválido; relatório não emitido para evitar omissão.`);
}
export function normalizeCompanyResponse(payload:unknown):CompanyRecord{
 const envelope=obj(payload);if(Number(obj(envelope?.status)?.code)!==4000)throw new Error('Consulta empresarial sem confirmação de sucesso (4000).');
 const data=obj(envelope?.data);if(!data)throw new Error('Resposta empresarial sem objeto data.');
 const basic=obj(data.basic);if(!basic||basic.error||obj(basic.status)?.code && ![4000,2000].includes(Number(obj(basic.status)?.code)))throw new Error('Dataset basic ausente ou com erro.');
 return {basic,phones:list(data,'phones'),addresses:list(data,'addresses'),emails:list(data,'emails'),relationships:list(data,'relationships'),lawsuits:list(data,'lawsuits')};
}
function row(label:string,v:unknown):string{return v===undefined||v===null||v===''?'':`<div class="field"><dt>${esc(label)}</dt><dd>${esc(v)}</dd></div>`;}
function section(title:string,inside:string):string{return `<section class="section"><h2>${esc(title)}</h2>${inside||'<p class="muted">Nenhum registro retornado.</p>'}</section>`;}
function money(v:unknown):string {if(v===null||v===undefined||v==='')return '';const n=Number(v);return Number.isFinite(n)?new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(n):text(v);}
function date(v:unknown):string{return v?formatDatePtBr(v):'';}
function enumText(v:unknown):string{return v!==undefined&&v!==null?translateEnum(formatCompanyValue(v)):'';}
function fieldBasic(b:Record<string,unknown>,cnpj:string):string{
 const tax=obj(b.tax_id)??{};const registration=obj(b.state_registration)??{};
 const economic=obj(b.economic_activities)??obj(b.economic_activity)??obj(b.activities)??{};
 const cnaes=obj(b.cnae)??obj(b.cnaes)??{};
 const firstAvailable=(...values:unknown[]):unknown=>values.find(v=>v!==undefined&&v!==null&&v!==''&&(!Array.isArray(v)||v.length>0));
 const mainActivities=companyActivityList(firstAvailable(
   b.primary_activities,b.primary_activity,b.main_activity,b.main_activities,
   economic.primary,economic.main,economic.principal,economic.primary_activity,
   cnaes.primary,cnaes.main,cnaes.principal));
 const secondary=companyActivityList(firstAvailable(
   b.secondary_activities,b.secondary_activity,b.other_activities,
   economic.secondary,economic.secondary_activities,economic.others,
   cnaes.secondary,cnaes.other));
 const fields:[string,unknown][]=[
 ['Razão social',get(b,'legal_name','company_name','corporate_name','business_name','name')],['Nome fantasia',get(b,'trade_name','fantasy_name')],
 ['CNPJ',formatCnpj(text(get(tax,'number')??get(b,'cnpj')??cnpj))],
 ['Situação cadastral',enumText(get(b,'registration_status','status','tax_status'))],
 ['Inscrição estadual',get(registration,'number')??get(b,'state_registration')],
 ['Fundação',date(get(b,'foundation_date','founding_date','opening_date','date_of_foundation'))],
 ['Tipo de estabelecimento',enumText(get(b,'establishment_type','branch_type'))],
 ['Regime tributário',enumText(get(b,'tax_regime'))],['Porte',enumText(get(b,'size','company_size'))],
 ['Natureza jurídica',get(b,'legal_nature','legal_nature_name','legal_type')],
 ['Capital social',money(get(b,'share_capital','capital','social_capital'))]
 ];
 const activities=(v:unknown[]):string=>v.map((x,i)=>row(String(i+1).padStart(2,'0'),formatCompanyActivity(x))).join('');
 return fields.map(([l,v])=>row(l,v)).join('')+section('Atividade econômica principal',activities(mainActivities))+section('Atividades econômicas secundárias',activities(secondary));
}
function caseCompetence(p:Record<string,unknown>):unknown{return resolveJudicialCompetence(p).displayValue;}
function isCriminal(p:Record<string,unknown>):boolean{return resolveJudicialCompetence(p).criminal;}
function caseItem(p0:unknown,i:number):string{
 const p=obj(p0)??{};const criminal=isCriminal(p);
 const fields:[string,unknown][]=[['Número',get(p,'number','case_number')?formatCaseNumber(get(p,'number','case_number')):undefined],['Tipo',enumText(get(p,'type'))],['Assunto',get(p,'primary_subject','subject')],['Tribunal',get(p,'court_name','court')],['Vara',get(p,'court_branch','branch')],['Comarca',get(p,'court_district')],['Competência',enumText(caseCompetence(p))],['Situação',enumText(get(p,'status'))]];
 const parties=Array.isArray(p.parties)?p.parties:[];const events=Array.isArray(p.events)?p.events:[];
 const partHtml=parties.map((v,j)=>{const x=obj(v)??{},details=obj(x.details)??{};return `<div class="party"><strong>${j+1}. ${esc(get(x,'name')??'Nome não informado')}</strong>${row('Documento',formatCpfOrCnpj(get(x,'doc','document')??''))}${row('Polo',enumText(get(x,'role','polo')))}${row('Participação',enumText(get(details,'type')??get(x,'type')))}${row('OAB',get(details,'oab_number'))}</div>`;}).join('');
 const activity=(title:string,values:unknown[]):string=>values.length?`<h4>${title} (${values.length} disponíveis)</h4>${values.map((v,j)=>{const x=obj(v)??{};return `<div class="event"><b>${esc(date(get(x,'date'))||j+1)}</b><span>${esc(get(x,'content','description','type')??'Sem descrição')}</span></div>`;}).join('')}`:'';
 return `<article class="processo${criminal?' criminal':''}"><div class="case-title"><strong>PROCESSO ${String(i+1).padStart(2,'0')} — ${esc(get(p,'number','case_number')?formatCaseNumber(get(p,'number','case_number')):'Número não informado')}</strong><span>${esc(enumText(caseCompetence(p))||'Competência não informada')}</span></div>${fields.map(([l,v])=>row(l,v)).join('')}${parties.length?`<h4>Partes envolvidas (${parties.length})</h4>${partHtml}`:''}${activity('Movimentações',events)}${activity('Petições',Array.isArray(p.petitions)?p.petitions:[])}${activity('Decisões',Array.isArray(p.decisions)?p.decisions:[])}</article>`;
}
export function renderCompanyHtml(record:CompanyRecord,cnpj:string,consultedAt:string):string{
 const company=text(get(record.basic,'legal_name','company_name','corporate_name','business_name')??get(obj(record.basic.name)??{},'legal_name','full_name')??get(record.basic,'name')??'Razão social não informada');
 const stamp=new Date(consultedAt);const when=Number.isFinite(stamp.getTime())?stamp.toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}):'Não informada';
 const phoneRows=record.phones.map((v,i)=>row(String(i+1).padStart(2,'0'),formatPhoneRecord(v))).join('');
 const addressRows=record.addresses.map((v,i)=>row(String(i+1).padStart(2,'0'),formatAddressRecord(v))).join('');
 const emailRows=record.emails.map((v,i)=>{const x=obj(v)??{};return row(String(i+1).padStart(2,'0'),get(x,'email','address','value')??text(v));}).join('');
 const relationshipRows=record.relationships.map((v,i)=>{const x=obj(v)??{};const tax=obj(x.tax_id)??{};return `<div class="relationship"><strong>${i+1}. ${esc(get(x,'name','full_name','legal_name')??'Identificação não informada')}</strong>${row('Documento',formatCpfOrCnpj(get(x,'doc','document')??get(tax,'number')??(typeof x.tax_id==='string'?x.tax_id:'')))}${row('Relação',enumText(get(x,'relationship_type','type','role','relationship')))}${row('Nível',enumText(get(x,'level','degree')))}</div>`;}).join('');
 const htmlBody=section('Dados básicos',fieldBasic(record.basic,cnpj)) + section('E-mails',emailRows) + section('Endereços',addressRows)+section('Telefones',phoneRows)+section(`Pessoas e empresas relacionadas (${record.relationships.length})`,relationshipRows)+section(`Processos judiciais (${record.lawsuits.length})`,record.lawsuits.map(caseItem).join(''));
 return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none'; connect-src 'none'"><title>Relatório empresarial</title><style>
 @page{size:A4;margin:16mm 17mm 18mm;@bottom-center{content:'Página ' counter(page) ' de ' counter(pages);color:#6d7c92;font-size:8pt}}
 *{box-sizing:border-box}body{font:9pt/1.43 Arial,Helvetica,sans-serif;color:#21334c;margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}h1{font-size:17pt;margin:0 0 2mm}header{border-bottom:1px solid #d8e1eb;padding-bottom:6mm;margin-bottom:8mm}header p{color:#637990;font-size:9pt;margin:0}.identity{background:#f3f6fa;border-radius:8px;padding:5mm 6mm;margin-bottom:7mm}.identity span{display:block;font-size:8pt;color:#60758b;text-transform:uppercase;font-weight:700}.identity strong{font-size:13pt;display:block;margin:2mm 0}.identity small{font-size:8.5pt;color:#546982}
 .section{margin-bottom:7mm}.section h2{font-size:11pt;border-left:4px solid #2460a7;padding-left:3mm;margin:0 0 3mm;break-after:avoid}.field{display:grid;grid-template-columns:32% 1fr;gap:3mm;padding:1.5mm .5mm;border-bottom:1px solid #e0e7ee;break-inside:avoid}.field dt{font-size:8pt;color:#5b6c85;font-weight:650;overflow-wrap:anywhere}.field dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}.muted{color:#718198;font-size:8pt}.relationship,.party{padding:2.5mm 1mm;border-bottom:1px solid #e4eaf1;break-inside:avoid}.relationship strong,.party strong{display:block;font-size:9pt}.relationship .field,.party .field{border:0;padding:.7mm 0}.processo{padding:3mm 4mm;border:1px solid #dbe3ed;border-left:4px solid #2460a7;border-radius:6px;margin-bottom:5mm;break-inside:auto}.processo.criminal{border-color:#e8aaaa;border-left-color:#b51d25;background:#fffafa}.case-title{display:flex;justify-content:space-between;gap:4mm;border-bottom:1px solid #e2e7f0;padding-bottom:3mm;margin-bottom:2mm;break-after:avoid}.case-title strong{font-size:9pt}.case-title span{font-size:8pt;padding:1mm 2mm;background:#eaf0f8;border-radius:4px}.processo.criminal .case-title strong{color:#a21520}.processo.criminal .case-title span{background:#fee1e2;color:#a21520}h4{font-size:9pt;color:#3b5f86;margin:4mm 0 2mm;break-after:avoid}.event{display:grid;grid-template-columns:26mm 1fr;gap:2mm;padding:1.5mm 0;border-bottom:1px solid #e2e8f0;break-inside:avoid}.event b{color:#66809c;font-size:8pt}.event span{overflow-wrap:anywhere}
 </style></head><body><header><h1>RELATÓRIO EMPRESARIAL</h1><p>Dados cadastrais, contatos, vínculos e informações processuais</p></header><div class="identity"><span>Empresa consultada</span><strong>${esc(company)}</strong><small>CNPJ: ${esc(formatCnpj(cnpj))} &nbsp;|&nbsp; Consulta: ${esc(when)}</small></div>${htmlBody}</body></html>`;
}

import type { ReportPayload } from './types.ts';
import { formatAddressRecord, formatCaseNumber, formatCpfOrCnpj, formatDatePtBr, formatPhoneRecord, translateEnum } from './localization.ts';
import { isExplicitCriminal, resolveJudicialCompetence } from './judicial.ts';
import { normalizeJudicialDataset } from './normalizer.ts';

function obj(v:unknown):Record<string,unknown>|null{return v!==null && typeof v==='object' && !Array.isArray(v)?v as Record<string,unknown>:null;}
function array(v:unknown):unknown[]{return Array.isArray(v)?v:[];}
function val(v:unknown):string{return v===null||v===undefined?'':String(v).trim();}
function html(v:unknown):string {return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function cell(label:string,value:unknown,cls=''):string{
  if(value===undefined || value===null || value==='')return '';
  return `<div class="field${cls?' '+cls:''}"><dt>${html(label)}</dt><dd>${html(value)}</dd></div>`;
}
function titledRows(title:string,rows:string,extra=''):string{
  return `<section class="section ${extra}"><h2>${html(title)}</h2>${rows || '<p class="muted">Nenhum registro retornado.</p>'}</section>`;
}
function pick(item:Record<string,unknown>, ...keys:string[]):unknown {
  for(const key of keys){if(item[key]!==undefined && item[key]!==null && item[key]!=='')return item[key];}
  return undefined;
}
function identityName(basic:Record<string,unknown>):string{
  const name=pick(basic,'full_name');
  const nested=obj(basic.name);
  const fromNested=pick(nested??{},'full_name','name');
  const fromPerson=pick(obj(basic.person)??{},'full_name','name');
  for(const source of [name,fromNested,fromPerson,basic.name])if(typeof source==='string'&&source.trim())return source.trim();
  return 'Nome não informado pela fonte';
}
function basicRows(basic:Record<string,unknown>,cpf:string):string{
  const tax=obj(basic.tax_id)??{};
  const social=obj(basic.social_security)??{};
  const name=identityName(basic);
  const fields:[string,unknown][]=[
    ['Nome',name],['Gênero',pick(basic,'gender')!==undefined?translateEnum(basic.gender):undefined],
    ['Nascimento',pick(basic,'birthdate','birth_date')?formatDatePtBr(pick(basic,'birthdate','birth_date')):undefined],
    ['Idade',pick(basic,'age')],['CPF',formatCpfOrCnpj(pick(tax,'number')??cpf)],
    ['Situação do CPF',pick(tax,'status')?translateEnum(tax.status):undefined],
    ['Região fiscal',pick(tax,'fiscal_region')],
    ['Data de registro do CPF',pick(tax,'registration_date')?formatDatePtBr(tax.registration_date):undefined],
    ['PIS',pick(social,'number')],['Nome da mãe',pick(basic,'mother_name')],
    ['Nome do pai',pick(basic,'father_name')],['Nacionalidade',pick(basic,'nationality')],
    ['Signo',pick(basic,'zodiac_sign')?translateEnum(basic.zodiac_sign):undefined],
    ['Signo chinês',pick(basic,'chinese_sign')?translateEnum(basic.chinese_sign):undefined]
  ];
  return fields.map(([key,value])=>cell(key,value)).join('');
}
function contacts(name:string, items:unknown[], render:(v:unknown)=>string):string{
  return titledRows(name,items.map((item,i)=>cell(String(i+1).padStart(2,'0'),render(item),'contact-row')).join(''));
}
function emailRows(items:unknown[]):string{
  return titledRows('E-mails',items.map((item,i)=>{
    const o=obj(item);
    return cell(String(i+1).padStart(2,'0'),o?pick(o,'email','address','value')??'Não informado':String(item));
  }).join(''));
}
export function isCriminalCompetence(value:unknown):boolean {return isExplicitCriminal(value);}
function competence(p:Record<string,unknown>):unknown{return resolveJudicialCompetence(p).displayValue;}
function summaryRows(p:Record<string,unknown>):string{
  const num=pick(p,'number','case_number','process_number');
  const fields:[string,unknown][]=[
    ['Número',num?formatCaseNumber(num):undefined],
    ['Tipo',pick(p,'type')?translateEnum(p.type):undefined],
    ['Assunto',pick(p,'primary_subject','subject')],
    ['Tribunal',pick(p,'court_name','court')],
    ['Vara',pick(p,'court_branch','branch','courtroom')],
    ['Comarca',pick(p,'court_district','district')],
    ['UF',pick(p,'court_state','state')],
    ['Competência',competence(p)?translateEnum(competence(p)):undefined],
    ['Situação',pick(p,'status')?translateEnum(p.status):undefined],
    ['Assunto CNJ',pick(p,'cnj_subject_name')],
    ['Classe CNJ',pick(p,'cnj_class_name','cnj_procedure_type_name')],
    ['Total de partes informado',pick(p,'total_parties')],
    ['Total de movimentações informado',pick(p,'total_events')],
    ['Data do último andamento',pick(p,'last_event_date')?formatDatePtBr(p.last_event_date):undefined],
    ['Data de arquivamento',pick(p,'closing_date')?formatDatePtBr(p.closing_date):undefined]
  ];
  return fields.map(([key,value])=>cell(key,value)).join('');
}
function renderParties(value:unknown):string{
  const parties=array(value);
  if(!parties.length)return '';
  return `<div class="subsection"><h4>Partes envolvidas (${parties.length})</h4>${parties.map((party,i)=>{
    const p=obj(party)??{};
    const details=obj(p.details)??{};
    const data=[
      cell('Identificação',pick(p,'doc','document')?formatCpfOrCnpj(pick(p,'doc','document')):undefined),
      cell('Polo',pick(p,'role','polo')?translateEnum(pick(p,'role','polo')):undefined),
      cell('Participação',pick(details,'type')?translateEnum(details.type):pick(p,'type')?translateEnum(p.type):undefined),
      cell('OAB',pick(details,'oab_number')?[val(details.oab_number),val(details.oab_state)].filter(Boolean).join(' / '):undefined)
    ].join('');
    return `<div class="party"><div class="party-heading"><span class="index">${i+1}.</span><strong>${html(pick(p,'name')??'Nome não informado')}</strong></div><div class="party-details">${data}</div></div>`;
  }).join('')}</div>`;
}
function renderActivity(title:string,v:unknown):string{
  const events=array(v);
  if(!events.length)return '';
  return `<div class="subsection"><h4>${html(title)} (${events.length} disponíveis)</h4>${events.map((event,i)=>{
    const data=obj(event)??{};
    const date=pick(data,'date')?formatDatePtBr(data.date):undefined;
    const content=pick(data,'content','type','description')??'Descrição não informada';
    const author=pick(data,'author');
    return `<div class="activity"><span class="activity-date">${html(date??String(i+1).padStart(2,'0'))}</span><div>${html(content)}${author?`<div class="muted">Autor: ${html(author)}</div>`:''}</div></div>`;
  }).join('')}</div>`;
}
function renderCase(v:unknown,i:number):string{
  const p=obj(v)??{};
  const red=resolveJudicialCompetence(p).criminal;
  const num=pick(p,'number','case_number','process_number');
  const title=num?formatCaseNumber(num):`Processo ${String(i+1).padStart(2,'0')}`;
  return `<article class="processo${red?' criminal':''}"><div class="case-head"><div><span class="eyebrow">PROCESSO ${String(i+1).padStart(2,'0')}</span><h3>${html(title)}</h3></div><span class="sphere${red?' criminal-label':''}">${html(competence(p)?translateEnum(competence(p)):'Competência não informada')}</span></div>
  <div class="summary">${summaryRows(p)}</div>${renderParties(pick(p,'parties'))}${renderActivity('Movimentações',pick(p,'events','movements'))}${renderActivity('Petições',pick(p,'petitions'))}${renderActivity('Decisões',pick(p,'decisions'))}</article>`;
}
export function renderReportHtml(report:ReportPayload):string{
  const basic=obj(report.data.basic.value)??{};
  const phones=array(obj(report.data.phones.value)?.items);
  const addresses=array(obj(report.data.addresses.value)?.items);
  const emails=array(obj(report.data.emails.value)?.items);
  const lawsuits=normalizeJudicialDataset(report.data.lawsuits.value).items;
  const name=identityName(basic);
  const date=new Date(report.consultedAt);
  const when=Number.isNaN(date.getTime())?'Não informada':date.toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'});
  const body=[
    titledRows('Dados básicos',basicRows(basic,report.cpf)),
    contacts('Telefones',phones,formatPhoneRecord),
    contacts('Endereços',addresses,formatAddressRecord),
    emailRows(emails),
    `<section class="section processes"><h2>Processos judiciais <span class="count">(${lawsuits.length})</span></h2>${lawsuits.length?lawsuits.map(renderCase).join(''):'<p class="muted">Nenhum processo retornado.</p>'}</section>`
  ].join('');
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"/><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none'; connect-src 'none'"><title>Relatório de consulta</title><style>
  @page{size:A4;margin:16mm 17mm 19mm;@bottom-center{content:'Página ' counter(page) ' de ' counter(pages);color:#70809a;font-size:7.5pt}}
  *{box-sizing:border-box}body{font:9.2pt/1.42 Arial,Helvetica,sans-serif;color:#203451;margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  header{padding:0 0 6mm;border-bottom:1px solid #d8e1eb;margin:0 0 8mm;display:flex;justify-content:space-between;align-items:start;gap:5mm}header>div{min-width:0;flex:1 1 auto}h1{margin:0;font-size:17pt;letter-spacing:-.3px;font-weight:750;white-space:nowrap}header p{margin:1mm 0 0;color:#697b94;font-size:8.5pt}
  .identity{padding:5mm 6mm;margin:0 0 7mm;background:#f1f4f9;border-radius:9px}.eyebrow{color:#66778f;font-size:7.5pt;font-weight:bold;letter-spacing:.08em;display:block;margin-bottom:2mm}.identity strong{display:block;font-size:14pt;margin-bottom:1.5mm}.identity small{color:#66778f;font-size:8.5pt}
  .section{margin:0 0 6mm}.section h2{font-size:11pt;margin:0 0 3mm;padding-left:3.5mm;border-left:4px solid #2662a9;break-after:avoid;line-height:1.35}.count{font-size:9pt;color:#748299;font-weight:400}
  .field{display:grid;grid-template-columns:31% 1fr;gap:4mm;align-items:start;border-bottom:1px solid #dce4ee;padding:1.6mm 1mm;break-inside:avoid}.field dt{color:#65778f;font-size:8pt;font-weight:600;overflow-wrap:anywhere}.field dd{margin:0;font-size:8.7pt;white-space:pre-wrap;overflow-wrap:anywhere}
  .contact-row{grid-template-columns:12mm 1fr}.contact-row dt{font-weight:700;color:#557093}
  .muted{color:#6b7d95;font-size:8.5pt}.processes{margin-top:8mm}.processo{padding:3.5mm 4mm;border:1px solid #d9e2ec;border-left:4px solid #2662a9;border-radius:7px;margin:0 0 5mm;break-inside:auto}.processo.criminal{border-color:#e9b7b7;border-left-color:#c02020;background:#fffafa}.case-head{display:flex;justify-content:space-between;align-items:start;gap:4mm;break-after:avoid;border-bottom:1px solid #dce4ee;padding-bottom:3mm;margin-bottom:2mm}.case-head h3{margin:0;font-size:10pt;overflow-wrap:anywhere}.processo.criminal .case-head h3,.processo.criminal .case-head .eyebrow{color:#9f1616}
  .sphere{background:#ecf2f8;color:#486580;padding:1mm 2.5mm;border-radius:4px;font-size:7.5pt;font-weight:700;max-width:42%;overflow-wrap:anywhere}.criminal-label{background:#fde7e7;color:#a31a1a}.summary{margin:0 0 2mm}
  .subsection{margin-top:4mm}.subsection h4{margin:0 0 2mm;font-size:9pt;color:#36587e;border-bottom:1px solid #dce4ee;padding-bottom:1.5mm;break-after:avoid}.party{padding:2mm 0;border-bottom:1px solid #e5eaf1;break-inside:avoid}.party-heading{display:flex;align-items:baseline;gap:2mm;font-size:8.5pt}.party-heading strong{font-weight:650}.index{font-size:8pt;color:#70809a}.party-details{padding-left:5mm}.party-details .field{border:0;padding:0.6mm 0;grid-template-columns:32% 1fr}.party-details dt,.party-details dd{font-size:8pt}
  .activity{display:grid;grid-template-columns:27mm 1fr;gap:2mm;border-bottom:1px solid #e4eaf1;padding:1.7mm 0;break-inside:avoid;font-size:8.3pt}.activity-date{color:#5e7793;font-weight:600}.footer-note{border-top:1px solid #dae3ee;color:#70809a;font-size:7.3pt;margin-top:8mm;padding-top:3mm}
  .demo{display:inline-block;color:#61738a;font-size:7.5pt;margin-top:1.5mm}
  </style></head><body><header><div><h1>RELATÓRIO DE CONSULTA</h1><p>Dados cadastrais, contatos e informações processuais</p>${report.demonstration?'<span class="demo">DEMONSTRAÇÃO — DADOS FICTÍCIOS</span>':''}</div></header>
  <div class="identity"><span class="eyebrow">PESSOA CONSULTADA</span><strong>${html(name)}</strong><small>CPF: ${html(formatCpfOrCnpj(report.cpf))} &nbsp;|&nbsp; Consulta: ${html(when)}</small></div>
  ${body}</body></html>`;
}

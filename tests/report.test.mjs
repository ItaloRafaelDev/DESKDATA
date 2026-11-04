import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReportHtml, isCriminalCompetence } from '../src/shared/report.ts';
import { normalizeDeskdataResponse } from '../src/shared/normalizer.ts';
const data = {
  basic: { name: {full_name:'PESSOA DEMONSTRATIVA'}, birthdate: '1980-01-01' },
  phones: {items: []}, addresses: {items: []}, emails: {items: []},
  lawsuits: {items: [
    {number: '0000001-00.2020.8.00.0000', court_type:'Criminal', sphere:'Cível', parties:[{name:'<script>alert(1)</script>', role:'ACTIVE'}]},
    {number: '0000002-00.2020.8.00.0000', court_type:'CIVEL', sphere:'Criminal', status:'Ativo'}
  ]}
};
const doc={cpf:'52998224725',consultedAt:'2026-10-30T12:00:00Z',data:normalizeDeskdataResponse({status:{code:4000},data})};
test('destaque vermelho depende da competência, NÃO da esfera',()=>{
  assert.equal(isCriminalCompetence('criminal'),true);
  assert.equal(isCriminalCompetence('CRIMINAL'),true);
  assert.equal(isCriminalCompetence('Cível'),false);
  assert.equal(isCriminalCompetence(undefined),false);
  const html=renderReportHtml(doc);
  assert.equal((html.match(/class="processo criminal"/g)||[]).length,1);
  assert.equal((html.match(/class="processo"/g)||[]).length,1);
  assert.match(html,/0000001-00/);assert.match(html,/0000002-00/);
  assert.match(html,/Competência/);
});
test('PDF entregue ao cliente não revela fornecedor, origem ou etiqueta do modelo',()=>{
  const html=renderReportHtml(doc);
  assert.doesNotMatch(html,/Deskdata|DESKDATA|MODELO 01|Fonte:|consulta autorizada à API/i);
  assert.match(html,/RELATÓRIO DE CONSULTA/);
});
test('campos provenientes do JSON são escapados',()=>{
  const html=renderReportHtml(doc);
  assert.doesNotMatch(html,/<script>/);
  assert.match(html,/&lt;script&gt;/);
});
test('modelo executivo apresenta dados legíveis em português',()=>{
 const nested=normalizeDeskdataResponse({status:{code:4000},data:{
  basic:{age:54,birthdate:'1972-04-05T00:00:00Z',gender:'M',name:{full_name:'PESSOA FICTÍCIA'},tax_id:{number:'52998224725',status:'REGULAR',registration_date:'2005-07-28T00:00:00Z'},mother_name:'MÃE FICTÍCIA'},
  phones:{items:[{country_code:55,area_code:11,number:'45840511',type:'WORK'}]},
  addresses:{items:[{street_type:'AV',street_name:'DOS TESTES',number:123,city:'CIDADE TESTE',state:'SP',zip_code:'13216701'}]},
  emails:{items:[]},
  lawsuits:{items:[{number:'50002612320214036304',type:'PROCEDIMENTO DO JUIZADO ESPECIAL CIVEL',court_type:'ESPECIAL CIVEL',status:'ARQUIVADO',total_events:59,parties:[{name:'PESSOA FICTÍCIA',role:'ACTIVE',type:'AUTHOR',details:{type:'AUTOR'}}],events:[{content:'ARQUIVADO DEFINITIVAMENTE',date:'2025-11-04T00:00:00'}]}]}
 }});
 const html=renderReportHtml({cpf:'52998224725',consultedAt:'2026-10-30T12:00:00Z',data:nested});
 assert.match(html,/PESSOA FICTÍCIA/);assert.match(html,/05\/04\/1972/);
 assert.match(html,/Comercial.*\+55 \(11\) 4584-0511/s);
 assert.match(html,/5000261-23\.2021\.4\.03\.6304/);
 assert.match(html,/Movimentações/);
 assert.doesNotMatch(html,/Full Name Word Count|Court Name|1972-04-05T00/);
});

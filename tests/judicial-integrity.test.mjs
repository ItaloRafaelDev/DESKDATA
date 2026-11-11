import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDeskdataResponse, DataContractError } from '../src/shared/normalizer.ts';
import { normalizeCompanyResponse, renderCompanyHtml } from '../src/shared/company-report.ts';
import { classifyCpiPerson } from '../src/main/cpi/person-rules.ts';
import { renderReportHtml } from '../src/shared/report.ts';

const envelope=lawsuits=>({status:{code:4000},data:{basic:{name:'PESSOA FICTÍCIA'},
  phones:{items:[]},addresses:{items:[]},emails:{items:[]},lawsuits}});
const normalized=lawsuits=>normalizeDeskdataResponse(envelope(lawsuits));
const report=data=>renderReportHtml({cpf:'52998224725',consultedAt:'2026-11-11T12:00:00Z',data});

for(const [name,lawsuits,code] of [
  ['total positivo com lista vazia',{total:1,items:[]},'total_mismatch'],
  ['total maior que lista',{total:2,items:[{court_type:'Civil'}]},'total_mismatch'],
  ['total menor que lista',{total:0,items:[{court_type:'Criminal'}]},'total_mismatch'],
  ['contador de participação maior que lista',{total:0,total_as_author:1,items:[]},'role_count_exceeds_total'],
  ['item nulo',{items:[null]},'invalid_item'],
  ['item primitivo',{items:['Criminal']},'invalid_item'],
  ['item array',{items:[[]]},'invalid_item']
]){
  test(`judicial: ${name} bloqueia PDF e normalização`,()=>{
    assert.throws(()=>normalized(lawsuits),error=>{
      assert.ok(error instanceof DataContractError);
      assert.equal(error.issue.code,code);
      return true;
    });
    // A fronteira do renderer também recusa NormalizedData adulterado/inconsistente.
    const data=normalized({items:[]});data.lawsuits={status:'ok',value:lawsuits};
    assert.throws(()=>report(data),/lawsuits/);
  });
}

for(const field of ['total','total_as_author','total_as_defendant','total_as_other']){
  for(const value of [-1,0.5,'1',null,true,Number.MAX_SAFE_INTEGER+1,NaN,Infinity]){
    test(`judicial: ${field} inválido (${String(value)}) não sofre coerção`,()=>{
      assert.throws(()=>normalized({items:[],[field]:value}),error=>{
        assert.equal(error.issue.code,'invalid_counter');assert.equal(error.issue.field,field);return true;
      });
    });
  }
}

test('judicial: contadores opcionais e papéis sobrepostos não são somados',()=>{
  assert.equal(classifyCpiPerson(normalized({items:[]})).result,'information');
  const data=normalized({total:1,total_as_author:1,total_as_defendant:1,total_as_other:0,items:[{court_type:'Civil'}]});
  assert.equal(classifyCpiPerson(data).result,'information');
});

for(const [value,result] of [[' Civil ','information'],['Cível','information'],['trabalhista','information'],
  ['CRIMINAL','restrictions'],[' Críminal ','restrictions'],['ESPECIAL   CÍVEL','information']]){
  test(`judicial: valor explícito normalizado ${value} concorda no PDF e CPI`,()=>{
    const data=normalized({total:1,items:[{number:'PROCESSO-FICTICIO',court_type:value}]});
    assert.deepEqual(classifyCpiPerson(data),{state:'classified',result,count:1});
    assert.equal((report(data).match(/class="processo criminal"/g)||[]).length,result==='restrictions'?1:0);
  });
}

for(const item of [{court_type:'XXXXX'},{court_type:'UNKNOWN'},{court_type:'Civil / Criminal'},
  {court_type:42},{court_type:{}},{court_type:''},{},{court_type:'Criminal',competence:'Civil'},
  {court_type:'',competence:'Criminal'},{court_type:' ',competence:'',competencia:'Civil'}]){
  test(`judicial: campo não comprovado exige revisão (${JSON.stringify(item)})`,()=>{
    assert.deepEqual(classifyCpiPerson(normalized({items:[item]})),{state:'review_required',reason:'unknown_competence'});
    assert.doesNotMatch(report(normalized({items:[item]})),/class="processo criminal"/);
  });
}

test('judicial: texto de vara, assunto, tipo e participação não infere criminalidade',()=>{
  const data=normalized({items:[{court_type:'Civil',court_branch:'Vara Criminal',primary_subject:'CRIMINAL',type:'Criminal',parties:[{role:'DEFENDANT'}]}]});
  assert.equal(classifyCpiPerson(data).result,'information');assert.doesNotMatch(report(data),/class="processo criminal"/);
});

test('judicial: campo alternativo não vazio é exibido sem autorizar equivalência nem destaque',()=>{
  const data=normalized({items:[{court_type:' ',competence:'',competencia:'Criminal'}]});
  const html=report(data);
  assert.match(html,/Criminal/);assert.doesNotMatch(html,/class="processo criminal"/);
  assert.deepEqual(classifyCpiPerson(data),{state:'review_required',reason:'unknown_competence'});
});

test('judicial: processos mistos são preservados integralmente e sem mutar JSON',()=>{
  const input=envelope({total:3,items:[{number:'CASO-FICTICIO-A',court_type:'Civil'},
    {number:'CASO-FICTICIO-B',court_type:'Criminal'},{number:'CASO-FICTICIO-C',court_type:'Trabalhista'}]});
  const before=structuredClone(input),data=normalizeDeskdataResponse(input),html=report(data);
  assert.deepEqual(input,before);assert.deepEqual(data.lawsuits.value.items,input.data.lawsuits.items);
  assert.deepEqual(classifyCpiPerson(data),{state:'classified',result:'restrictions',count:3});
  assert.equal((html.match(/<article class="processo/g)||[]).length,3);
  for(const id of ['CASO-FICTICIO-A','CASO-FICTICIO-B','CASO-FICTICIO-C'])assert.ok(html.includes(id));
  assert.equal((html.match(/class="processo criminal"/g)||[]).length,1);
});

test('judicial: criminal conhecido não libera lista com outro processo desconhecido',()=>{
  assert.deepEqual(classifyCpiPerson(normalized({items:[{court_type:'Criminal'},{court_type:'XXXXX'}]})),
    {state:'review_required',reason:'unknown_competence'});
});

test('judicial: classificador revalida contadores mesmo se o normalizador for contornado',()=>{
  const data=normalized({items:[]});data.lawsuits={status:'empty',value:{total:2,items:[]}};
  assert.deepEqual(classifyCpiPerson(data),{state:'review_required',reason:'incomplete_lawsuits'});
});

test('judicial: normalização empresarial compartilha validação sem omitir processos',()=>{
  const input=envelope({total:1,items:[]});input.data.relationships={items:[]};
  assert.throws(()=>normalizeCompanyResponse(input),/lawsuits/);
  input.data.lawsuits={total:2,items:[{number:'EMPRESA-CASO-A',court_type:'Criminal'},{number:'EMPRESA-CASO-B',court_type:'Civil'}]};
  const record=normalizeCompanyResponse(input),html=renderCompanyHtml(record,'11222333000181','2026-11-11');
  assert.match(html,/EMPRESA-CASO-A/);assert.match(html,/EMPRESA-CASO-B/);
  assert.equal((html.match(/class="processo criminal"/g)||[]).length,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidCnpj, cnpjDigits, formatCnpj } from '../src/shared/cnpj.ts';
import { normalizeCompanyResponse, COMPANY_DATASETS } from '../src/shared/company-report.ts';
import { renderCompanyHtml } from '../src/shared/company-report.ts';
import { assertRecoveredCnpj } from '../src/shared/company-identity.ts';
const basic={legal_name:'EMPRESA DEMONSTRAÇÃO LTDA',tax_id:{number:'11222333000181'},status:'ACTIVE',share_capital:1234567.45};
const payload={status:{code:4000},data:{basic,phones:{items:[]},addresses:{items:[]},emails:{items:[]},relationships:{items:[{name:'EXEMPLO SOCIO',type:'PARTNER',tax_id:'12345678901'}]},lawsuits:{items:[{number:'1000000-00.2026.8.26.0100',court_type:'CRIMINAL',type:'INQUERITO',parties:[{name:'EXEMPLO',role:'PASSIVE',type:'DEFENDANT'}],events:[{date:'2026-10-12T00:00:00Z',content:'MOVIMENTAÇÃO'}]}]}}};
test('validate CNPJ with check digits and format',()=>{assert.equal(isValidCnpj('11.222.333/0001-81'),true);assert.equal(isValidCnpj('11.222.333/0001-82'),false);assert.equal(cnpjDigits('11.222.333/0001-81'),'11222333000181');assert.equal(formatCnpj('11222333000181'),'11.222.333/0001-81');});
test('only six currently available datasets',()=>{assert.deepEqual(COMPANY_DATASETS,['basic','phones','addresses','emails','relationships','lawsuits']);});
test('validates per dataset without silently ignoring missing data',()=>{assert.equal(normalizeCompanyResponse(payload).lawsuits.length,1);assert.throws(()=>normalizeCompanyResponse({status:{code:4000},data:{...payload.data,lawsuits:null}}),/lawsuits/);assert.throws(()=>normalizeCompanyResponse({status:{code:4000},data:{...payload.data,relationships:{}}}),/relationships/);});
test('empty list requires explicit zero count',()=>{assert.equal(normalizeCompanyResponse({status:{code:4000},data:{...payload.data,lawsuits:{total:0}}}).lawsuits.length,0);});
test('recovered result rejects unrelated company identification',()=>{assert.doesNotThrow(()=>assertRecoveredCnpj(payload,'11222333000181'));assert.throws(()=>assertRecoveredCnpj(payload,'11222333000182'),/CNPJ/);});
test('HTML formats BRL and highlights only criminal competence, not sphere',()=>{const report=normalizeCompanyResponse(payload);const html=renderCompanyHtml(report,'11222333000181','2026-10-30T17:00:00Z');assert.match(html,/EMPRESA DEMONSTRAÇÃO/);assert.match(html,/R\$\s?1\.234\.567,45/);assert.match(html,/class="processo criminal"/);assert.doesNotMatch(html,/Fonte:|Deskdata|MODELO 01/);const civil={...report,lawsuits:[{number:'99',sphere:'CRIMINAL',court_type:'CIVEL'}]};assert.doesNotMatch(renderCompanyHtml(civil,'11222333000181','2026-10-30T17:00:00Z'),/class="processo criminal"/);});
test('HTML escapes external text',()=>{const html=renderCompanyHtml({...normalizeCompanyResponse(payload),basic:{legal_name:'<script>alert(1)</script>'}},'11222333000181','2026-10-30');assert.doesNotMatch(html,/<script>alert/);});
test('company terminology is displayed in Brazilian Portuguese',async()=>{
 const {translateEnum}=await import('../src/shared/localization.ts');
 assert.equal(translateEnum('PARTNER'),'Sócio');
 assert.equal(translateEnum('DIRECT'),'Direto');
 assert.equal(translateEnum('EMPLOYEE'),'Empregado');
 assert.equal(translateEnum('HEADQUARTERS'),'Matriz');
});

test('CNPJ renders nested legal name, state registration and legal nature instead of [object Object]',()=>{
 const record={...normalizeCompanyResponse(payload),basic:{
   name:{full_name:'EMPRESA DE EXEMPLO LTDA'},
   tax_id:{number:'11222333000181'},
   state_registration:{SP:{number:'110042490114'},RJ:{number:'000009871'}},
   legal_nature:{code:'2062',description:'SOCIEDADE EMPRESÁRIA LIMITADA'},
   foundation_date:'2020-04-05'
 }};
 const html=renderCompanyHtml(record,'11222333000181','2026-11-04T12:00:00Z');
 assert.doesNotMatch(html,/\[object Object\]/);
 assert.match(html,/Razão social<\/dt><dd>EMPRESA DE EXEMPLO LTDA/);
 assert.match(html,/Inscrição estadual<\/dt><dd>[^<]*110042490114/);
 assert.match(html,/Inscrição estadual<\/dt><dd>[^<]*000009871/);
 assert.match(html,/Natureza jurídica<\/dt><dd>2062 — SOCIEDADE EMPRESÁRIA LIMITADA/);
});

test('CNPJ handles economic activities nested as primary/secondary objects without dropping the data',()=>{
 const record={...normalizeCompanyResponse(payload),basic:{
   legal_name:'EMPRESA DE EXEMPLO LTDA',
   economic_activities:{
     primary:{code:'6201501',description:'Desenvolvimento de programas de computador'},
     secondary:[{code:'6202300',description:'Consultoria em tecnologia'}]
   }
 }};
 const html=renderCompanyHtml(record,'11222333000181','2026-11-04T12:00:00Z');
 assert.match(html,/6201501 — Desenvolvimento de programas de computador/);
 assert.match(html,/6202300 — Consultoria em tecnologia/);
 assert.doesNotMatch(html,/\[object Object\]/);
});

test('CNPJ nested unknown metadata uses a safe human-readable fallback, never JS object coercion',()=>{
 const record={...normalizeCompanyResponse(payload),basic:{
  legal_name:'EMPRESA EXEMPLO',
  legal_nature:{legal_class:{code:'XX',description:'CATEGORIA DESCRITIVA'}},
  registration_status:{code:'ACTIVE',date:'2026-08-20'}
 }};
 const html=renderCompanyHtml(record,'11222333000181','2026-11-04T12:00:00Z');
 assert.doesNotMatch(html,/\[object Object\]|\[object Array\]/);
 assert.match(html,/CATEGORIA DESCRITIVA/);
 assert.match(html,/20\/08\/2026/);
});

test('CNPJ escapes nested structures in PDF HTML without discarding descriptions',()=>{
 const html=renderCompanyHtml({...normalizeCompanyResponse(payload),basic:{
  legal_name:'EXEMPLO LTDA',legal_nature:{code:'2062',description:'<script>alert(1)</script> SOCIEDADE LTDA'}
 }},'11222333000181','2026-11-04T12:00:00Z');
 assert.match(html,/2062 — &lt;script&gt;alert\(1\)&lt;\/script&gt; SOCIEDADE LTDA/);
 assert.doesNotMatch(html,/<script>alert\(1\)<\/script>/);
});

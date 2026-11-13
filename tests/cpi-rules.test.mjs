import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDeskdataResponse } from '../src/shared/normalizer.ts';
import { classifyCpiPerson } from '../src/main/cpi/person-rules.ts';

function payload(items){return normalizeDeskdataResponse({status:{code:4000},data:{basic:{name:'TESTE'},phones:{items:[]},addresses:{items:[]},emails:{items:[]},lawsuits:{items}}});}
test('CPI: presença de competência Criminal prevalece sobre cível',()=>{
 assert.deepEqual(classifyCpiPerson(payload([{court_type:'Civil'},{court_type:'criminal'}])),{state:'classified',result:'restrictions',count:2});
});
test('CPI: apenas competências não criminais => Há Informações',()=>{
 assert.deepEqual(classifyCpiPerson(payload([{court_type:'TRABALHISTA'},{court_type:'FAZENDA'}])),{state:'classified',result:'information',count:2});
});
test('CPI: nenhuma ocorrência judicial => Há Informações conforme regra aprovada',()=>{
 assert.deepEqual(classifyCpiPerson(payload([])),{state:'classified',result:'information',count:0});
});
test('CPI: Especial Criminal => restrição',()=>{
 assert.deepEqual(classifyCpiPerson(payload([{court_type:'ESPECIAL CRIMINAL'}])),{state:'classified',result:'restrictions',count:1});
});
test('CPI: competência em branco ou ausente => Há Informações',()=>{
 assert.deepEqual(classifyCpiPerson(payload([{court_type:''},{number:'000'}])),{state:'classified',result:'information',count:2});
});
test('CPI: competência desconhecida não criminal => Há Informações',()=>{
 assert.deepEqual(classifyCpiPerson(payload([{court_type:'ELEITORAL'}])),{state:'classified',result:'information',count:1});
});
test('CPI: criminal no campo competencia (alias) => restrição',()=>{
 assert.deepEqual(classifyCpiPerson(payload([{court_type:'',competencia:'Vara Criminal'}])),{state:'classified',result:'restrictions',count:1});
});
test('CPI: criminal com acento ou caixa diferente => restrição',()=>{
 assert.deepEqual(classifyCpiPerson(payload([{court_type:'Juizado Especial Criminal'}])),{state:'classified',result:'restrictions',count:1});
});
test('CPI: palavra parecida sem ser CRIMINAL não é restrição',()=>{
 assert.deepEqual(classifyCpiPerson(payload([{court_type:'CRIMINALISTICA'}])),{state:'classified',result:'information',count:1});
});
test('CPI: campo de competência não textual => revisão',()=>{
 assert.deepEqual(classifyCpiPerson(payload([{court_type:23}])),{state:'review_required',reason:'unknown_competence'});
});
test('CPI: dataset judicial ausente ou inválido => revisão',()=>{
 const data=payload([]);data.lawsuits={status:'ok',value:{items:'invalido'}};
 assert.deepEqual(classifyCpiPerson(data),{state:'review_required',reason:'incomplete_lawsuits'});
});

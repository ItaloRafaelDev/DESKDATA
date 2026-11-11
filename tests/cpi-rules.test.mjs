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
test('CPI: competência ausente => revisão, não inferência',()=>{
 assert.deepEqual(classifyCpiPerson(payload([{court_type:'CRIMINAL'},{number:'000'}])),{state:'review_required',reason:'unknown_competence'});
});
test('CPI: dataset judicial ausente ou inválido => revisão',()=>{
 const data=payload([]);data.lawsuits={status:'ok',value:{items:'invalido'}};
 assert.deepEqual(classifyCpiPerson(data),{state:'review_required',reason:'incomplete_lawsuits'});
});

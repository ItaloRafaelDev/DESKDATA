import test from 'node:test';
import assert from 'node:assert/strict';
import {formatDatePtBr, translateEnum, formatPhoneRecord, formatAddressRecord, formatCaseNumber} from '../src/shared/localization.ts';

test('datas ISO são apresentadas em pt-BR sem mudança de dia por fuso',()=>{
 assert.equal(formatDatePtBr('1972-04-05T00:00:00Z'),'05/04/1972');
 assert.equal(formatDatePtBr('2026-01-22T19:02:06.000-03:00'),'22/01/2026');
 assert.equal(formatDatePtBr('0000-12-31T20:53:32.000-03:06'),'Não informada');
});
test('valores controlados e papéis processuais são traduzidos sem presumir culpa',()=>{
 assert.equal(translateEnum('WORK'),'Comercial');
 assert.equal(translateEnum('ACTIVE'),'Ativo');
 assert.equal(translateEnum('PASSIVE'),'Passivo');
 assert.equal(translateEnum('NEUTRAL'),'Neutro');
 assert.equal(translateEnum('AUTHOR'),'Autor');
 assert.equal(translateEnum('DEFENDANT'),'Réu');
 assert.equal(translateEnum('LAWYER'),'Advogado');
 assert.equal(translateEnum('M'),'Masculino');
});
test('telefone e endereço seguem apresentação brasileira',()=>{
 assert.equal(formatPhoneRecord({country_code:55,area_code:11,number:'45840511',type:'WORK'}),'Comercial — +55 (11) 4584-0511');
 assert.match(formatAddressRecord({street_type:'AV',street_name:'DOS TESTES',number:123,neighborhood:'CENTRO',city:'CIDADE TESTE',state:'SP',zip_code:'13216701',type:'WORK'}),/Av\. DOS TESTES, nº 123.*CEP 13216-701/);
 assert.equal(formatCaseNumber('50002612320214036304'),'5000261-23.2021.4.03.6304');
});

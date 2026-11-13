import test from 'node:test';
import assert from 'node:assert/strict';
import { CPI_AUXILIARY_URL_TEXT, classifyCpiHttpResponse, classifyCpiVisibleServerError, hasConfirmedSavedCpiResponse, isCpiAuxiliaryResource,
  judgeSavedCpiResponse, savedResponseEvidenceFromDom } from '../src/main/cpi/response-confirmation.ts';

const verified={matchingIds:true,statusRespondida:true,matchingResult:true,matchingSource:true,
  hasResponseTimestamp:true,pdfAttachmentIndicated:true,editableUploadPresent:false,serverErrorVisible:false,auxiliary404Observed:false};

test('aceita somente evidencias completas da resposta salva com documento PDF',()=>{
 assert.equal(hasConfirmedSavedCpiResponse(verified),true);
 for(const field of ['matchingIds','statusRespondida','matchingResult','matchingSource','hasResponseTimestamp','pdfAttachmentIndicated']){
   assert.equal(hasConfirmedSavedCpiResponse({...verified,[field]:false}),false,field);
 }
 assert.equal(hasConfirmedSavedCpiResponse({...verified,editableUploadPresent:true}),false);
 assert.equal(hasConfirmedSavedCpiResponse({...verified,serverErrorVisible:true}),false);
});


test('ignora SOMENTE o 404 observado no recurso auxiliar, com aviso, sem aceitar outros erros',()=>{
 const observed='404;404; Erro de Servidor no Aplicativo "/". Nao e possivel encontrar o recurso. URL solicitada: /cpi_api_request.aspx';
 assert.deepEqual(classifyCpiVisibleServerError(observed),{blocking:false,auxiliary404:true});
 assert.equal(hasConfirmedSavedCpiResponse({...verified,auxiliary404Observed:true}),true);
 assert.deepEqual(classifyCpiVisibleServerError('Erro de Servidor no Aplicativo. URL solicitada: /upd_cad.aspx'),{blocking:true,auxiliary404:false});
 assert.deepEqual(classifyCpiVisibleServerError('404;404; Erro de Servidor no Aplicativo. URL solicitada: /outra_rota.aspx'),{blocking:true,auxiliary404:false});
 assert.deepEqual(classifyCpiVisibleServerError('Status: Respondida. Resultado: Ha Informacoes. Documento PDF.'),{blocking:false,auxiliary404:false});
 assert.equal(hasConfirmedSavedCpiResponse({...verified,auxiliary404Observed:true,matchingIds:false}),false);
 assert.equal(hasConfirmedSavedCpiResponse({...verified,auxiliary404Observed:true,serverErrorVisible:true}),false);
});

const base='https://adm.cpicentral.com.br';
test('HTTP: falha do documento principal bloqueia; 404 de cpi_api_request.aspx é só aviso em qualquer frame',()=>{
 assert.equal(isCpiAuxiliaryResource(`${base}/cpi_api_request.aspx?x=1`),true);
 assert.equal(isCpiAuxiliaryResource(`${base}/zpersEspecial/pesquisas/upd_cad/mod_tt_pesq_upd.aspx`),false);
 assert.equal(isCpiAuxiliaryResource('não é URL'),false);
 const form=`${base}/zpersEspecial/pesquisas/upd_cad/mod_tt_pesq_upd.aspx?id_sol=275064&id_pesq_tipo=537987`;
 assert.equal(classifyCpiHttpResponse({url:form,status:500,mainDocument:true}),'main_failed');
 assert.equal(classifyCpiHttpResponse({url:form,status:404,mainDocument:true}),'main_failed');
 assert.equal(classifyCpiHttpResponse({url:form,status:200,mainDocument:true}),'ignored');
 // Auditoria: o erro do documento principal prevalece sobre a exceção auxiliar, inclusive com a URL auxiliar.
 assert.equal(classifyCpiHttpResponse({url:`${base}/cpi_api_request.aspx`,status:404,mainDocument:true}),'main_failed');
 assert.equal(classifyCpiHttpResponse({url:`${base}/cpi_api_request.aspx`,status:404,mainDocument:false}),'auxiliary_404');
 // Outra falha do recurso auxiliar não é mascarada como o 404 conhecido.
 assert.equal(classifyCpiHttpResponse({url:`${base}/cpi_api_request.aspx`,status:500,mainDocument:false}),'auxiliary_failed');
 assert.equal(classifyCpiHttpResponse({url:`${base}/cpi_api_request.aspx`,status:403,mainDocument:false}),'auxiliary_failed');
 assert.equal(classifyCpiHttpResponse({url:`${base}/img/logo.png`,status:404,mainDocument:false}),'ignored');
});

const dom=(extra={})=>({titles:[],cpfText:'',pesquisaType:'',status:'',savedStatus:'Respondida',savedResult:'Há Informações',
  savedSource:'Desk Data',responseTimestamp:'11/11/2026 10:30:00',pdfDocument:'Documento PDF',editableUploadPresent:false,
  errorSignals:'',businessErrorVisible:false,...extra});
test('veredito de persistência: confirmed só com status, classificação, data, fonte e Documento PDF',()=>{
 assert.equal(judgeSavedCpiResponse(savedResponseEvidenceFromDom(dom(),'information')),'confirmed');
 assert.equal(judgeSavedCpiResponse(savedResponseEvidenceFromDom(dom({savedResult:'Sim, Consta Restrições'}),'restrictions')),'confirmed');
 for(const extra of [{savedStatus:'Aguardando Pesquisa'},{savedResult:'Nada Consta'},{savedSource:'Outra Fonte'},
   {responseTimestamp:'31/02/2026 10:00'},{pdfDocument:''},{editableUploadPresent:true}]){
   assert.equal(judgeSavedCpiResponse(savedResponseEvidenceFromDom(dom(extra),'information')),'absent',JSON.stringify(extra));
 }
 assert.equal(judgeSavedCpiResponse(savedResponseEvidenceFromDom(dom(),'restrictions')),'absent');
 const aux='404;404; ERRO DE SERVIDOR NO APLICATIVO NAO E POSSIVEL ENCONTRAR O RECURSO URL SOLICITADA: /CPI_API_REQUEST.ASPX';
 const withAux=savedResponseEvidenceFromDom(dom({errorSignals:aux}),'information');
 assert.equal(withAux.auxiliary404Observed,true);assert.equal(judgeSavedCpiResponse(withAux),'confirmed');
 assert.equal(judgeSavedCpiResponse(savedResponseEvidenceFromDom(dom({errorSignals:aux,pdfDocument:''}),'information')),'absent');
 assert.equal(judgeSavedCpiResponse(savedResponseEvidenceFromDom(dom({errorSignals:'ERRO DE SERVIDOR NO APLICATIVO'}),'information')),'unavailable');
 assert.equal(judgeSavedCpiResponse(savedResponseEvidenceFromDom(dom({businessErrorVisible:true}),'information')),'unavailable');
 assert.equal(judgeSavedCpiResponse(null),'unavailable');
});

test('recurso auxiliar: somente HTTPS, host oficial e caminho exato',()=>{
 for(const url of [`${base}/cpi_api_request.aspx`,`${base}/CPI_API_REQUEST.ASPX`,`${base}/cpi_api_request.aspx?id=1&x=2`,`${base}/cpi_api_request.aspx#a`]){
   assert.equal(isCpiAuxiliaryResource(url),true,url);
   assert.equal(classifyCpiHttpResponse({url,status:404,mainDocument:false}),'auxiliary_404',url);
 }
 for(const url of [
   'http://adm.cpicentral.com.br/cpi_api_request.aspx',          // protocolo
   'https://evil.example/cpi_api_request.aspx',                  // outra origem
   'https://adm.cpicentral.com.br.evil.example/cpi_api_request.aspx',
   'https://outro.cpicentral.com.br/cpi_api_request.aspx',       // subdomínio
   'https://adm.cpicentral.com.br:8443/cpi_api_request.aspx',    // porta
   'https://user:pass@adm.cpicentral.com.br/cpi_api_request.aspx',
   `${base}/x/cpi_api_request.aspx`, `${base}/cpi_api_request.aspx/x`, `${base}/cpi_api_request.aspx.bak`,
   `${base}/cpi_api_request.aspxx`, `${base}/cpi_api_request_aspx`, `${base}/xcpi_api_request.aspx`,
   'data:text/html,cpi_api_request.aspx','about:blank'
 ]){
   assert.equal(isCpiAuxiliaryResource(url),false,url);
   assert.equal(classifyCpiHttpResponse({url,status:404,mainDocument:false}),'ignored',url);
   assert.equal(classifyCpiHttpResponse({url,status:404,mainDocument:true}),'main_failed',url);
 }
 assert.equal(classifyCpiHttpResponse({url:`${base}/cpi_api_request.aspx`,status:Number.NaN,mainDocument:true}),'ignored');
});

test('texto do 404 auxiliar: caminho exato; URL semelhante continua erro bloqueante',()=>{
 const page=url=>`404;404; Erro de Servidor no Aplicativo "/". Nao e possivel encontrar o recurso. Descricao: HTTP 404. URL solicitada: ${url}`;
 for(const url of ['/cpi_api_request.aspx','cpi_api_request.aspx','/cpi_api_request.aspx.','/cpi_api_request.aspx?id=1','/CPI_API_REQUEST.ASPX'])
   assert.deepEqual(classifyCpiVisibleServerError(page(url)),{blocking:false,auxiliary404:true},url);
 for(const url of ['/cpi_api_request.aspx.bak','/cpi_api_request.aspx/x','/x/cpi_api_request.aspx','/cpi_api_request.aspxx','/cpi_api_request.asp'])
   assert.deepEqual(classifyCpiVisibleServerError(page(url)),{blocking:true,auxiliary404:false},url);
 // Sem indicação de 404, o mesmo caminho não vira exceção.
 assert.deepEqual(classifyCpiVisibleServerError('Erro de Servidor no Aplicativo "/". URL solicitada: /cpi_api_request.aspx'),{blocking:true,auxiliary404:false});
});

test('o leitor DOM (serializado no frame) usa o mesmo padrão estrito de URL auxiliar',async()=>{
 const {readFile}=await import('node:fs/promises');
 const source=await readFile(new URL('../src/main/cpi/pending-details.ts',import.meta.url),'utf8');
 assert.ok(source.includes(`/${CPI_AUXILIARY_URL_TEXT.source}/.test(visibleText)`),'padrão divergente entre pending-details.ts e response-confirmation.ts');
});

test('indicação "Documento PDF" é exigida por texto exato e não é tratada como prova do arquivo',()=>{
 for(const pdfDocument of ['','Documento','Documento PDF pendente','PDF','Sem arquivo'])
   assert.equal(savedResponseEvidenceFromDom(dom({pdfDocument}),'information').pdfAttachmentIndicated,false,pdfDocument);
 assert.equal(savedResponseEvidenceFromDom(dom({pdfDocument:'  documento   pdf '}),'information').pdfAttachmentIndicated,true);
 // A evidência só tem o campo de indicação; nenhum campo afirma existência, nome, hash ou tamanho do arquivo remoto.
 assert.deepEqual(Object.keys(savedResponseEvidenceFromDom(dom(),'information')).filter(key=>/pdf|attach|file/i.test(key)),['pdfAttachmentIndicated']);
});

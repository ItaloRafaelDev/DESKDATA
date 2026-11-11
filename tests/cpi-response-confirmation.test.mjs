import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCpiVisibleServerError, hasConfirmedSavedCpiResponse } from '../src/main/cpi/response-confirmation.ts';

const verified={matchingIds:true,statusRespondida:true,matchingResult:true,
  hasResponseTimestamp:true,hasPdfDocument:true,editableUploadPresent:false,serverErrorVisible:false,auxiliary404Observed:false};

test('aceita somente evidencias completas da resposta salva com documento PDF',()=>{
 assert.equal(hasConfirmedSavedCpiResponse(verified),true);
 for(const field of ['matchingIds','statusRespondida','matchingResult','hasResponseTimestamp','hasPdfDocument']){
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

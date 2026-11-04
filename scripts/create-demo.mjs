import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderReportHtml } from '../src/shared/report.ts';
import { normalizeDeskdataResponse } from '../src/shared/normalizer.ts';
const base=dirname(fileURLToPath(import.meta.url));
const payload={
  status:{code:4000,message:'Success'},
  data:{
    basic:{name:'PESSOA DEMONSTRATIVA',cpf:'000.000.000-00',birthdate:'01/01/1980',mother_name:'NOME FAMILIAR FICTÍCIO',nationality:'Brasileira'},
    phones:{items:[{type:'Celular',number:'+55 (11) 90000-0000'},{type:'Fixo',number:'+55 (11) 3000-0000'}]},
    addresses:{items:[{type:'Residencial',street:'Rua Exemplo, 123',neighborhood:'Centro',city:'Cidade Demonstrativa',state:'SP',zip_code:'00000-000'}]},
    emails:{items:[]},
    lawsuits:{items:[
      {number:'0000000-00.2025.8.00.0000',type:'Procedimento ilustrativo',court_type:'Cível',status:'Arquivado',court:'Tribunal demonstrativo',subject:'Assunto fictício',parties:[{name:'PESSOA DEMONSTRATIVA',role:'Requerente'},{name:'PARTE DEMONSTRATIVA',role:'Requerida'}],movements:[{date:'01/01/2025',description:'Movimentação fictícia'}]},
      {number:'0000000-00.2024.8.00.0000',type:'Procedimento ilustrativo',court_type:'Criminal',status:'Arquivado',court:'Tribunal demonstrativo',subject:'Assunto fictício',parties:[{name:'PESSOA DEMONSTRATIVA',role:'Parte identificada'}],movements:[{date:'02/01/2025',description:'Movimentação fictícia'}]}
    ]}
  }
};
const report={demonstration:true,cpf:'00000000000',consultedAt:'2026-10-30T12:00:00Z',data:normalizeDeskdataResponse(payload)};
await mkdir(join(base,'../examples'),{recursive:true});
await writeFile(join(base,'../examples','modelo-01-demonstracao.html'),renderReportHtml(report),'utf8');
console.log('HTML demonstrativo gerado em examples/modelo-01-demonstracao.html (sem consultas reais).');

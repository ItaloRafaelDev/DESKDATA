import { writeFile } from 'node:fs/promises';
import { normalizePisResult, renderPisPdfHtml } from '../src/shared/pis-report.ts';
const cpf='52998224725';
const fake={status:{code:4000},data:{basic:{name:{full_name:'Pessoa de Demonstração'},gender:'FEMALE',birthdate:'1997-11-26T00:00:00Z',age:28,tax_id:{number:cpf,status:'REGULAR',fiscal_region:'SP',registration_date:'2009-12-02T00:00:00Z'},social_security:{number:'14265531608'}}}};
await writeFile(process.argv[2]??'pis-demonstracao.html',renderPisPdfHtml(normalizePisResult(fake,cpf)));

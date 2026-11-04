import { cnpjDigits } from './cnpj.ts';
function obj(v:unknown):Record<string,unknown>|null{return v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;}
/** A recuperação só é aceita quando o próprio retorno confirma o CNPJ da empresa. */
export function assertRecoveredCnpj(payload:unknown,requested:string):void{
 const response=obj(payload);const data=obj(response?.data);const basic=obj(data?.basic);
 const tax=obj(basic?.tax_id);const company=obj(basic?.company);
 const candidate=[response?.key_value,obj(response?.query)?.key_value,tax?.number,basic?.cnpj,company?.cnpj,company?.tax_id].find(v=>typeof v==='string'&&cnpjDigits(v).length===14);
 if(typeof candidate!=='string')throw new Error('CNPJ não confirmado no retorno. Não foi possível associar com segurança a consulta recuperada.');
 if(cnpjDigits(candidate)!==cnpjDigits(requested))throw new Error('CNPJ retornado não corresponde à empresa solicitada.');
}

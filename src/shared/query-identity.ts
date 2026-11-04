function object(value:unknown):Record<string,unknown>|null {
  return value!==null && typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
}
/** Para código fornecido manualmente, exige CPF identificável e correspondente no retorno. */
export function assertRecoveredCpf(payload:unknown,cpf:string):void {
  const envelope=object(payload);
  const data=object(envelope?.data);
  const basic=object(data?.basic);
  const tax=object(basic?.tax_id);
  const identifier=tax?.number ?? basic?.cpf;
  const found=typeof identifier==='string'||typeof identifier==='number' ? String(identifier).replace(/\D/g,'') : '';
  if(found.length!==11)throw new Error('Não foi possível confirmar o CPF do resultado recuperado. Nenhum PDF será associado a esse código.');
  if(found!==cpf)throw new Error('O CPF informado não corresponde ao resultado deste código de consulta.');
}

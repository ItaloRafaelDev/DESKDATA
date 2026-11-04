export function cnpjDigits(raw:string):string {return raw.replace(/\D/g,'');}
export function formatCnpj(raw:string):string{const d=cnpjDigits(raw);return d.length===14?`${d.slice(0,2)}.${d.slice(2,5)}.${d.slice(5,8)}/${d.slice(8,12)}-${d.slice(12)}`:raw;}
export function isValidCnpj(raw:unknown):boolean{
  if(typeof raw!=='string')return false;
  const d=cnpjDigits(raw);
  if(!/^\d{14}$/.test(d)||/^(\d)\1{13}$/.test(d))return false;
  const check=(first:number)=>{
    const weights=first===12?[5,4,3,2,9,8,7,6,5,4,3,2]:[6,5,4,3,2,9,8,7,6,5,4,3,2];
    const sum=weights.reduce((acc,w,i)=>acc+Number(d[i])*w,0);
    const rem=sum%11;
    return rem<2?0:11-rem;
  };
  return check(12)===Number(d[12])&&check(13)===Number(d[13]);
}

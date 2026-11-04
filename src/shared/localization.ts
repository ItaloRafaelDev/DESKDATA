/** Formatação de apresentação. Nunca altera o JSON recebido da Deskdata. */
function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function normalizeToken(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
}
const enums: Record<string, string> = {
  PARTNER:'Sócio', SHAREHOLDER:'Acionista', MANAGER:'Administrador', EMPLOYEE:'Empregado', EMPLOYER:'Empregador', DIRECT:'Direto', INDIRECT:'Indireto', HEADQUARTERS:'Matriz', BRANCH:'Filial',
  M:'Masculino', MALE:'Masculino', F:'Feminino', FEMALE:'Feminino',
  WORK:'Comercial', HOME:'Residencial', RESIDENTIAL:'Residencial', MOBILE:'Celular', CELL:'Celular', CELLULAR:'Celular',
  PERSONAL:'Pessoal', OTHER:'Outro', UNKNOWN:'Não informado',
  ACTIVE:'Ativo', PASSIVE:'Passivo', NEUTRAL:'Neutro', INACTIVE:'Inativo',
  AUTHOR:'Autor', AUTOR:'Autor', PLAINTIFF:'Autor', DEFENDANT:'Réu', REU:'Réu', LAWYER:'Advogado', ADVOGADO:'Advogado', ATTORNEY:'Advogado',
  JUDGE:'Juiz', VICTIM:'Vítima', WITNESS:'Testemunha', EXECUTED:'Executado', PETITIONER:'Requerente',
  CRIMINAL:'Criminal', CIVIL:'Cível', CÍVEL:'Cível', TRABALHISTA:'Trabalhista', TAX:'Tributária',
  REGULAR:'Regular', ARQUIVADO:'Arquivado', ARCHIVED:'Arquivado', OPEN:'Em andamento', CLOSED:'Encerrado',
  RAT:'Rato', OX:'Boi', TIGER:'Tigre', RABBIT:'Coelho', DRAGON:'Dragão', SNAKE:'Serpente', HORSE:'Cavalo',
  GOAT:'Cabra', MONKEY:'Macaco', ROOSTER:'Galo', DOG:'Cachorro', PIG:'Porco',
  ARIES:'Áries', TAURUS:'Touro', GEMINI:'Gêmeos', CANCER:'Câncer', LEO:'Leão', VIRGO:'Virgem',
  LIBRA:'Libra', SCORPIO:'Escorpião', SAGITTARIUS:'Sagitário', CAPRICORN:'Capricórnio', AQUARIUS:'Aquário', PISCES:'Peixes',
  'ESPECIAL CIVEL':'Especial cível', 'PROCEDIMENTO DO JUIZADO ESPECIAL CIVEL':'Procedimento do Juizado Especial Cível'
};
export function translateEnum(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Não informado';
  if (typeof value === 'boolean') return value ? 'Sim' : 'Não';
  const raw = String(value).trim();
  return enums[normalizeToken(raw)] ?? raw;
}
export function formatDatePtBr(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'Não informada';
  const raw=value.trim();
  const match=/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(raw);
  if (!match) return /^\d{2}\/\d{2}\/\d{4}$/.test(raw) ? raw : 'Não informada';
  const y=Number(match[1]),m=Number(match[2]),d=Number(match[3]);
  if (y<1900 || y>2100 || m<1 || m>12 || d<1 || d>31) return 'Não informada';
  const date=new Date(Date.UTC(y,m-1,d));
  if(date.getUTCFullYear()!==y || date.getUTCMonth()!==m-1 || date.getUTCDate()!==d) return 'Não informada';
  return `${match[3]}/${match[2]}/${match[1]}`;
}
export function formatCpfOrCnpj(value: unknown): string {
  const raw=String(value??'').trim();
  const digits=raw.replace(/\D/g,'');
  if(digits.length===11 && /^\d{11}$/.test(raw)) return digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/,'$1.$2.$3-$4');
  if(digits.length===14 && /^\d{14}$/.test(raw)) return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,'$1.$2.$3/$4-$5');
  return raw || 'Não informado';
}
export function formatCaseNumber(value: unknown): string {
  const raw=String(value??'').trim();
  return /^\d{20}$/.test(raw)?raw.replace(/^(\d{7})(\d{2})(\d{4})(\d)(\d{2})(\d{4})$/,'$1-$2.$3.$4.$5.$6'):raw;
}
const streetTypes:Record<string,string>={R:'R.', RUA:'Rua',AV:'Av.',AVENIDA:'Avenida',AL:'Al.',ALAMEDA:'Alameda',TRAVESSA:'Travessa',TV:'Trav.',ROD:'Rod.',RODOVIA:'Rodovia',PRACA:'Praça',PCA:'Praça'};
function str(v:unknown):string {return v===null||v===undefined?'':String(v).trim();}
function formatNumber(number: unknown):string {
  const dig = str(number).replace(/\D/g,'');
  if (dig.length===8) return `${dig.slice(0,4)}-${dig.slice(4)}`;
  if (dig.length===9) return `${dig.slice(0,5)}-${dig.slice(5)}`;
  return str(number);
}
export function formatPhoneRecord(value: unknown):string {
  const obj=asObject(value);
  if(!obj)return str(value)||'Não informado';
  const label=translateEnum(obj.type ?? obj.phone_type ?? 'Telefone');
  const country=str(obj.country_code), area=str(obj.area_code ?? obj.ddd), number=str(obj.number ?? obj.phone_number);
  const parts = [country?`+${country}`:'',area?`(${area})`:'',formatNumber(number)].filter(Boolean);
  return `${label} — ${parts.join(' ') || 'Número não informado'}`;
}
export function formatAddressRecord(value: unknown):string {
  const obj=asObject(value);
  if(!obj)return str(value)||'Não informado';
  const type=str(obj.street_type);
  const prefix=type?(streetTypes[normalizeToken(type)]??type):'';
  const street=[prefix,str(obj.street_name ?? obj.street)].filter(Boolean).join(' ');
  const number=str(obj.number);
  const complement=str(obj.complement);
  const locality=[str(obj.neighborhood),[str(obj.city),str(obj.state)].filter(Boolean).join(' - ')].filter(Boolean).join(' - ');
  const postal=str(obj.zip_code ?? obj.postal_code ?? obj.cep).replace(/\D/g,'');
  const cep=postal.length===8?`${postal.slice(0,5)}-${postal.slice(5)}`:str(obj.zip_code ?? obj.cep);
  return [street+(number?`, nº ${number}`:'')+(complement?`, ${complement}`:''), locality,cep?`CEP ${cep}`:''].filter(Boolean).join(' - ') || 'Não informado';
}
export function toPlainString(value: unknown): string {
  if (value===null||value===undefined||value==='') return 'Não informado';
  if(typeof value==='boolean')return value?'Sim':'Não';
  return typeof value==='number'?value.toLocaleString('pt-BR'):translateEnum(value);
}

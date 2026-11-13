import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CredentialProtector } from '../credentials.ts';
import { validateCpiRowId, type CpiPendingRowId } from './pending-rows.ts';
import { JUDICIAL_ISSUE_CODES, type JudicialIssueCode } from '../../shared/judicial.ts';

/** Dados de controle cifrados. Nenhum CPF, documento, PDF ou token é persistido aqui. */
export type CpiWorkStage = 'claimed'|'query_started'|'query_pending'|'pdf_ready'|'submit_started'|'completed'|'verification_required'|'review_required';
export type CpiVerificationReason = 'confirmed'|'remote_unverified'|'remote_unavailable'|'local_incomplete';
export interface CpiVerificationEvent { at:string; from:CpiWorkStage; to:CpiWorkStage; reason:CpiVerificationReason }
export interface CpiWorkItem extends CpiPendingRowId {
  account: string;
  stage: CpiWorkStage;
  historyRecordId?: string;
  classification?: 'restrictions'|'information';
  reviewReason?:JudicialIssueCode;
  createdAt?:string;
  submittedAt?:string;
  verificationEvents?:CpiVerificationEvent[];
  updatedAt: string;
}
type Stored = { version:1; items:CpiWorkItem[] };
const stages = new Set<CpiWorkStage>(['claimed','query_started','query_pending','pdf_ready','submit_started','completed','verification_required','review_required']);
const verificationReasons=new Set<CpiVerificationReason>(['confirmed','remote_unverified','remote_unavailable','local_incomplete']);
const validDate=(value:unknown):value is string=>typeof value==='string'&&!Number.isNaN(Date.parse(value));
function valid(row:unknown):row is CpiWorkItem {
  if (!row || typeof row!=='object') return false;
  const r=row as Partial<CpiWorkItem>;
  return !!validateCpiRowId(r) && typeof r.account==='string' && !!r.account.trim() &&
    stages.has(r.stage as CpiWorkStage) && validDate(r.updatedAt) &&
    (r.createdAt===undefined||validDate(r.createdAt)) && (r.submittedAt===undefined||validDate(r.submittedAt)) &&
    (r.verificationEvents===undefined||(Array.isArray(r.verificationEvents)&&r.verificationEvents.every(event=>
      event&&validDate(event.at)&&stages.has(event.from)&&stages.has(event.to)&&verificationReasons.has(event.reason)))) &&
    (r.historyRecordId===undefined || (typeof r.historyRecordId==='string' && /^[a-f0-9-]{30,50}$/i.test(r.historyRecordId))) &&
    (r.classification===undefined || r.classification==='restrictions' || r.classification==='information') &&
    (r.reviewReason===undefined || JUDICIAL_ISSUE_CODES.includes(r.reviewReason));
}
function key(account:string,ids:CpiPendingRowId):string {return `${account.trim().toLowerCase()}|${ids.solicitacaoId}|${ids.pesquisaId}`;}
function validStored(value:unknown):value is Stored {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const data=value as Partial<Stored>;
  if(data.version!==1||!Array.isArray(data.items))return false;
  const seen=new Set<string>();
  for(const row of data.items){
    if(!valid(row))return false;
    const id=key(row.account,row);
    if(seen.has(id))return false;
    seen.add(id);
  }
  return true;
}
/** Assinatura do arquivo cifrado: o cache só vale enquanto tamanho e mtime não mudam. */
type FileSignature = { size:number; mtimeMs:number };
const sameFile=(a:FileSignature,b:FileSignature):boolean=>a.size===b.size&&a.mtimeMs===b.mtimeMs;
/**
 * Sem teto de quantidade (D1). O conteúdo decifrado e validado fica em cache na memória do processo
 * principal, invalidado quando o arquivo muda; cada leitura devolve uma cópia (nunca a referência do cache).
 */
export class CpiWorkflowStore {
  private queue:Promise<void>=Promise.resolve();
  private cache:{signature:FileSignature;data:Stored}|null=null;
  private readonly path:string;
  private readonly directory:string;
  private readonly protector:CredentialProtector;
  constructor(directory:string,protector:CredentialProtector){this.directory=directory;this.protector=protector;this.path=join(directory,'cpi-workflows.bin');}
  private async signature():Promise<FileSignature|null>{
    try{const info=await stat(this.path);return {size:info.size,mtimeMs:info.mtimeMs};}
    catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
      throw new Error('Fila CPI indisponível; processamento bloqueado.',{cause:error});
    }
  }
  private async read():Promise<Stored>{
    const before=await this.signature();
    if(!before){this.cache=null;return {version:1,items:[]};}
    if(this.cache&&sameFile(this.cache.signature,before))return structuredClone(this.cache.data);
    let cipher:Buffer;
    try {cipher=await readFile(this.path);}catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT'){this.cache=null;return {version:1,items:[]};}
      throw new Error('Fila CPI indisponível; processamento bloqueado.',{cause:error});
    }
    if(!await this.protector.isAvailable())throw new Error('Proteção Windows indisponível; fila CPI bloqueada.');
    let parsed:unknown;
    try {parsed=JSON.parse((await this.protector.decrypt(cipher)).result);}
    catch {throw new Error('Fila CPI corrompida; processamento bloqueado para evitar duplicação.');}
    if(!validStored(parsed))throw new Error('Fila CPI corrompida; processamento bloqueado para evitar duplicação.');
    // Só reaproveita se o arquivo não mudou entre o stat e a leitura; caso contrário, relê na próxima chamada.
    const after=await this.signature();
    this.cache=after&&sameFile(before,after)&&after.size===cipher.length?{signature:after,data:structuredClone(parsed)}:null;
    return parsed;
  }
  private async write(data:Stored):Promise<void>{
    if(!validStored(data))throw new Error('Tentativa de persistir fila CPI inválida.');
    if(!await this.protector.isAvailable())throw new Error('Proteção Windows indisponível; fila CPI bloqueada.');
    this.cache=null;
    const cipher=await this.protector.encrypt(JSON.stringify(data));
    await mkdir(this.directory,{recursive:true});
    const temporary=join(this.directory,`cpi-workflows-${randomUUID()}.tmp`);
    try{await writeFile(temporary,cipher,{flag:'wx',mode:0o600});await rename(temporary,this.path);}
    catch{await unlink(temporary).catch(()=>{});throw new Error('Falha ao persistir a fila CPI. Operação bloqueada.');}
    const written=await this.signature().catch(()=>null);
    if(written&&written.size===cipher.length)this.cache={signature:written,data:structuredClone(data)};
  }
  private locked<T>(job:()=>Promise<T>):Promise<T>{
    const action=this.queue.then(job);
    this.queue=action.then(()=>undefined,()=>undefined);
    return action;
  }
  /** Histórico restrito à conta autenticada, em ordem decrescente de atualização. */
  async list(account:string):Promise<CpiWorkItem[]>{
    if(typeof account!=='string'||!account.trim())throw new Error('Conta CPI inválida.');
    await this.queue;
    return (await this.read()).items
      .filter(row=>row.account===account.trim().toLowerCase())
      .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))
      .map(row=>({...row}));
  }
  /** Página zero-based das pesquisas que exigem conferência; a conta é filtrada antes da paginação. */
  async listPending(account:string,page:number,pageSize:number):Promise<{total:number;page:number;pageSize:number;items:CpiWorkItem[]}>{
    if(typeof account!=='string'||!account.trim())throw new Error('Conta CPI inválida.');
    if(!Number.isSafeInteger(page)||page<0||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)throw new Error('Paginação CPI inválida.');
    await this.queue;
    const pending=(await this.read()).items.filter(row=>row.account===account.trim().toLowerCase()&&
      ['review_required','verification_required','submit_started','query_started'].includes(row.stage))
      .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
    return {total:pending.length,page,pageSize,items:pending.slice(page*pageSize,(page+1)*pageSize).map(row=>({...row}))};
  }
  async get(account:string,ids:CpiPendingRowId):Promise<CpiWorkItem|null>{
    if(!validateCpiRowId(ids)||!account.trim())throw new Error('Identificação CPI inválida.');
    await this.queue;
    return (await this.read()).items.find(row=>key(row.account,row)===key(account,ids))??null;
  }
  /** Estágios de várias linhas com uma única leitura da fila (seleção do FULL AUTO). */
  async stages(account:string,rows:readonly CpiPendingRowId[]):Promise<(CpiWorkStage|undefined)[]>{
    if(typeof account!=='string'||!account.trim()||!rows.every(ids=>validateCpiRowId(ids)))throw new Error('Identificação CPI inválida.');
    await this.queue;
    const byKey=new Map((await this.read()).items.map(row=>[key(row.account,row),row.stage]));
    return rows.map(ids=>byKey.get(key(account,ids)));
  }
  async claim(account:string,ids:CpiPendingRowId):Promise<CpiWorkItem>{
    if(!validateCpiRowId(ids)||!account.trim())throw new Error('Identificação CPI inválida.');
    return this.locked(async()=>{
      const db=await this.read();
      const previous=db.items.find(row=>key(row.account,row)===key(account,ids));
      if(previous)return previous;
      const now=new Date().toISOString();
      const entry:CpiWorkItem={...ids,account:account.trim().toLowerCase(),stage:'claimed',createdAt:now,updatedAt:now};
      db.items.push(entry);await this.write(db);return entry;
    });
  }
  async mark(account:string,ids:CpiPendingRowId,stage:CpiWorkStage,updates:Pick<CpiWorkItem,'historyRecordId'|'classification'|'reviewReason'>={}):Promise<CpiWorkItem>{
    if(!stages.has(stage))throw new Error('Estado CPI inválido.');
    return this.locked(async()=>{
      const db=await this.read();
      const index=db.items.findIndex(row=>key(row.account,row)===key(account,ids));
      if(index<0)throw new Error('Solicitação CPI não registrada.');
      const before=db.items[index];
      if((['completed','verification_required'].includes(before.stage) && stage!==before.stage) ||
        (before.stage==='submit_started' && !['submit_started','completed','verification_required','review_required'].includes(stage))){
        throw new Error('Envio CPI já iniciado ou encerrado; não será repetido automaticamente.');
      }
      const now=new Date().toISOString();
      const after:CpiWorkItem={...before,...updates,stage,updatedAt:now,
        ...(stage==='submit_started'&&!before.submittedAt?{submittedAt:now}:{})};
      if(!valid(after))throw new Error('Tentativa de persistir estado CPI inválido.');
      db.items[index]=after;await this.write(db);return after;
    });
  }
  /** A única transição de reconciliação é calculada após prova remota; o renderer não escolhe o estado. */
  async recordVerification(account:string,ids:CpiPendingRowId,reason:CpiVerificationReason):Promise<CpiWorkItem>{
    if(!validateCpiRowId(ids)||typeof account!=='string'||!account.trim()||!verificationReasons.has(reason))throw new Error('Verificação CPI inválida.');
    return this.locked(async()=>{
      const db=await this.read();
      const index=db.items.findIndex(row=>key(row.account,row)===key(account,ids));
      if(index<0||!['review_required','verification_required','submit_started'].includes(db.items[index].stage))throw new Error('Pesquisa CPI não está pendente de verificação.');
      const before=db.items[index];
      if(reason==='confirmed'&&(!before.historyRecordId||!before.classification))throw new Error('Vínculo local CPI incompleto; conclusão bloqueada.');
      const now=new Date().toISOString();
      const stage=reason==='confirmed'?'completed':before.stage==='submit_started'?'verification_required':before.stage;
      const event:CpiVerificationEvent={at:now,from:before.stage,to:stage,reason};
      const after:CpiWorkItem={...before,stage,updatedAt:now,verificationEvents:[...(before.verificationEvents??[]),event]};
      db.items[index]=after;
      await this.write(db);
      return after;
    });
  }
}

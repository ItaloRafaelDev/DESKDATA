import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CredentialProtector } from '../credentials.ts';
import { validateCpiRowId, type CpiPendingRowId } from './pending-rows.ts';

/** Dados de controle cifrados. Nenhum CPF, documento, PDF ou token é persistido aqui. */
export type CpiWorkStage = 'claimed'|'query_started'|'query_pending'|'pdf_ready'|'submit_started'|'completed'|'verification_required'|'review_required';
export interface CpiWorkItem extends CpiPendingRowId {
  account: string;
  stage: CpiWorkStage;
  historyRecordId?: string;
  classification?: 'restrictions'|'information';
  updatedAt: string;
}
type Stored = { version:1; items:CpiWorkItem[] };
const stages = new Set<CpiWorkStage>(['claimed','query_started','query_pending','pdf_ready','submit_started','completed','verification_required','review_required']);
function valid(row:unknown):row is CpiWorkItem {
  if (!row || typeof row!=='object') return false;
  const r=row as Partial<CpiWorkItem>;
  return !!validateCpiRowId(r) && typeof r.account==='string' && !!r.account.trim() &&
    stages.has(r.stage as CpiWorkStage) && typeof r.updatedAt==='string' && !Number.isNaN(Date.parse(r.updatedAt)) &&
    (r.historyRecordId===undefined || (typeof r.historyRecordId==='string' && /^[a-f0-9-]{30,50}$/i.test(r.historyRecordId))) &&
    (r.classification===undefined || r.classification==='restrictions' || r.classification==='information');
}
function key(account:string,ids:CpiPendingRowId):string {return `${account.trim().toLowerCase()}|${ids.solicitacaoId}|${ids.pesquisaId}`;}
export class CpiWorkflowStore {
  private queue:Promise<void>=Promise.resolve();
  private readonly path:string;
  private readonly directory:string;
  private readonly protector:CredentialProtector;
  constructor(directory:string,protector:CredentialProtector){this.directory=directory;this.protector=protector;this.path=join(directory,'cpi-workflows.bin');}
  private async read():Promise<Stored>{
    let cipher:Buffer;
    try {cipher=await readFile(this.path);}catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT')return {version:1,items:[]};
      throw new Error('Fila CPI indisponível; processamento bloqueado.');
    }
    if(!await this.protector.isAvailable())throw new Error('Proteção Windows indisponível; fila CPI bloqueada.');
    try {
      const parsed:unknown=JSON.parse((await this.protector.decrypt(cipher)).result);
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('Invalid');
      const data=parsed as Stored;
      if(data.version!==1||!Array.isArray(data.items)||data.items.length>10000||!data.items.every(valid))throw Error('Invalid');
      const seen=new Set<string>();
      for(const row of data.items){const k=key(row.account,row);if(seen.has(k))throw Error('Duplicate');seen.add(k);}
      return data;
    } catch {throw new Error('Fila CPI corrompida; processamento bloqueado para evitar duplicação.');}
  }
  private async write(data:Stored):Promise<void>{
    if(!await this.protector.isAvailable())throw new Error('Proteção Windows indisponível; fila CPI bloqueada.');
    const cipher=await this.protector.encrypt(JSON.stringify(data));
    await mkdir(this.directory,{recursive:true});
    const temporary=join(this.directory,`cpi-workflows-${randomUUID()}.tmp`);
    try{await writeFile(temporary,cipher,{flag:'wx',mode:0o600});await rename(temporary,this.path);}
    catch{await unlink(temporary).catch(()=>{});throw new Error('Falha ao persistir a fila CPI. Operação bloqueada.');}
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
  async get(account:string,ids:CpiPendingRowId):Promise<CpiWorkItem|null>{
    if(!validateCpiRowId(ids)||!account.trim())throw new Error('Identificação CPI inválida.');
    await this.queue;
    return (await this.read()).items.find(row=>key(row.account,row)===key(account,ids))??null;
  }
  async claim(account:string,ids:CpiPendingRowId):Promise<CpiWorkItem>{
    if(!validateCpiRowId(ids)||!account.trim())throw new Error('Identificação CPI inválida.');
    return this.locked(async()=>{
      const db=await this.read();
      const previous=db.items.find(row=>key(row.account,row)===key(account,ids));
      if(previous)return previous;
      const entry:CpiWorkItem={...ids,account:account.trim().toLowerCase(),stage:'claimed',updatedAt:new Date().toISOString()};
      db.items.push(entry);await this.write(db);return entry;
    });
  }
  async mark(account:string,ids:CpiPendingRowId,stage:CpiWorkStage,updates:Pick<CpiWorkItem,'historyRecordId'|'classification'>={}):Promise<CpiWorkItem>{
    if(!stages.has(stage))throw new Error('Estado CPI inválido.');
    return this.locked(async()=>{
      const db=await this.read();
      const index=db.items.findIndex(row=>key(row.account,row)===key(account,ids));
      if(index<0)throw new Error('Solicitação CPI não registrada.');
      const before=db.items[index];
      if((['completed','verification_required'].includes(before.stage) && stage!==before.stage) ||
        (before.stage==='submit_started' && !['submit_started','completed','verification_required'].includes(stage))){
        throw new Error('Envio CPI já iniciado ou encerrado; não será repetido automaticamente.');
      }
      const after:CpiWorkItem={...before,...updates,stage,updatedAt:new Date().toISOString()};
      if(!valid(after))throw new Error('Tentativa de persistir estado CPI inválido.');
      db.items[index]=after;await this.write(db);return after;
    });
  }
}

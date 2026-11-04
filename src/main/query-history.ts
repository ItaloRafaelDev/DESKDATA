import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import type { CredentialProtector } from './credentials.ts';

export interface QueryRecord {
  id: string;
  kind?: 'person' | 'pis' | 'company';
  cnpj?: string;
  account: string;
  cpf: string;
  requestedAt: string;
  updatedAt: string;
  queryCode?: string;
  status: 'uncertain' | 'pending' | 'paused' | 'ready' | 'pis_unavailable';
  pdfPaths: string[];
  lastIssue?: string;
}
type Kind='person'|'pis'|'company';
type SqlRow={id:string;payload:Uint8Array};
const statuses=new Set(['uncertain','pending','paused','ready','pis_unavailable']);
function validate(record:unknown):QueryRecord {
  if(!record||typeof record!=='object'||Array.isArray(record))throw Error('Registro inválido');
  const item=record as QueryRecord;
  if(typeof item.id!=='string'||typeof item.account!=='string'||typeof item.cpf!=='string'||
    typeof item.requestedAt!=='string'||typeof item.updatedAt!=='string'||!statuses.has(item.status)||
    !Array.isArray(item.pdfPaths)||!item.pdfPaths.every(p=>typeof p==='string')||
    (item.kind!==undefined&&!['person','pis','company'].includes(item.kind)))throw Error('Registro inválido');
  return item;
}

/** Banco transacional. Somente chaves HMAC e metadados não identificáveis ficam em claro. */
export class QueryHistoryStore {
  private db?:DatabaseSync;
  private key?:Buffer;
  private initializing?:Promise<void>;
  private mutation:Promise<unknown>=Promise.resolve();
  private closed=false;
  private closing?:Promise<void>;
  private readonly directory:string;
  private readonly protector:CredentialProtector;
  constructor(directory:string,protector:CredentialProtector){this.directory=directory;this.protector=protector;}
  private hash(account:string):string{
    if(!this.key)throw Error('Índice ainda não inicializado.');
    return createHmac('sha256',this.key).update(account.trim().toLowerCase()).digest('hex');
  }
  private identifierHash(account:string,kind:Kind,identity:string):string{
    if(!this.key)throw Error('Índice ainda não inicializado.');
    return createHmac('sha256',this.key).update(account.trim().toLowerCase()+'|'+kind+'|'+identity).digest('hex');
  }
  private async initialize():Promise<void>{
    if(!await this.protector.isAvailable())throw Error('Proteção de dados do Windows indisponível.');
    await mkdir(this.directory,{recursive:true});
    const keyFile=join(this.directory,'history-key.bin');
    const databasePath=join(this.directory,'queries.sqlite');
    const initializationMark=join(this.directory,'history-state.flag');
    const databaseExists=await access(databasePath).then(()=>true).catch(e=>{
      if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;
    });
    const priorInitialization=await access(initializationMark).then(()=>true).catch(e=>{
      if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;
    });
    if(priorInitialization&&!databaseExists)throw Error('Banco de consultas ausente. Restaure o backup; nenhuma consulta será executada.');
    let encrypted:Buffer;
    try{encrypted=await readFile(keyFile);}catch(e){
      if((e as NodeJS.ErrnoException).code!=='ENOENT')throw Error('Chave protegida do histórico inacessível.');
      // Um banco existente sem sua chave não pode ser reaberto com uma nova chave silenciosamente.
      const existingDb=await access(join(this.directory,'queries.sqlite')).then(()=>true).catch(e=>{
        if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;
      });
      if(existingDb)throw Error('Chave cifrada do SQLite ausente: restaure-a do backup antes de consultar.');
      const secret=randomBytes(32);encrypted=await this.protector.encrypt(secret.toString('hex'));
      try{await writeFile(keyFile,encrypted,{flag:'wx',mode:0o600});}
      catch(e2){if((e2 as NodeJS.ErrnoException).code!=='EEXIST')throw e2;encrypted=await readFile(keyFile);}
    }
    try{const decoded=await this.protector.decrypt(encrypted);if(!/^[a-f0-9]{64}$/.test(decoded.result))throw Error('Invalid key');this.key=Buffer.from(decoded.result,'hex');}
    catch{throw Error('Chave protegida do histórico corrompida ou incompatível com esta conta Windows.');}
    const db=new DatabaseSync(databasePath);
    try{
      db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS records(
          id TEXT PRIMARY KEY,account_key TEXT NOT NULL,kind TEXT NOT NULL,lookup_key TEXT NOT NULL,
          requested_at TEXT NOT NULL,status TEXT NOT NULL,payload BLOB NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_records_account ON records(account_key,kind,requested_at DESC);
        CREATE INDEX IF NOT EXISTS idx_records_lookup ON records(account_key,kind,lookup_key,requested_at DESC);
        CREATE TABLE IF NOT EXISTS metadata(name TEXT PRIMARY KEY,value TEXT NOT NULL);`);
      const good=db.prepare('PRAGMA integrity_check').get() as Record<string,string>;
      if(Object.values(good)[0]!=='ok')throw Error('Integridade inválida');
      this.db=db;
      await this.migrateLegacy();
      if(!priorInitialization){
        try{await writeFile(initializationMark,'initialized',{flag:'wx',mode:0o600});}
        catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
      }
    }catch(e){db.close();this.db=undefined;throw Error(`Banco de consultas indisponível: ${e instanceof Error?e.message:'erro desconhecido'}. Nenhuma consulta nova será realizada.`);}
  }
  private async ensure(allowClosing=false):Promise<DatabaseSync>{
    if(this.closed&&!allowClosing)throw Error('Histórico encerrado; crie uma nova instância para acessar o banco.');
    if(!this.initializing)this.initializing=this.initialize().catch(e=>{this.initializing=undefined;throw e;});
    await this.initializing;
    if(this.closed&&!allowClosing)throw Error('Histórico encerrado; crie uma nova instância para acessar o banco.');
    if(!this.db)throw Error('Banco de consultas não inicializado.');
    return this.db;
  }
  /** Aguarda as operações aceitas, fecha o arquivo SQLite e impede novas operações. */
  async close():Promise<void>{
    if(this.closing)return this.closing;
    this.closed=true;
    this.closing=(async()=>{
      await this.mutation;
      if(this.initializing)await this.initializing.catch(()=>{});
      const db=this.db;
      this.db=undefined;
      try{db?.close();}
      finally{this.key?.fill(0);this.key=undefined;}
    })();
    return this.closing;
  }
  private async encrypt(record:QueryRecord):Promise<Buffer>{return this.protector.encrypt(JSON.stringify(validate(record)));}
  private async decode(row:SqlRow):Promise<QueryRecord>{
    try{const result=await this.protector.decrypt(Buffer.from(row.payload));const data=validate(JSON.parse(result.result));if(data.id!==row.id)throw Error('ID mismatch');return data;}
    catch{throw Error('Registro do histórico corrompido. Novas consultas foram bloqueadas para evitar cobrança duplicada.');}
  }
  private async migrateLegacy():Promise<void>{
    const db=this.db!;
    if(db.prepare("SELECT value FROM metadata WHERE name='legacy_migrated'").get())return;
    let rows:QueryRecord[]=[];
    try{
      const cipher=await readFile(join(this.directory,'queries.bin'));
      const clear=await this.protector.decrypt(cipher);
      const data:unknown=JSON.parse(clear.result);
      if(!Array.isArray(data))throw Error('Legacy invalid');
      rows=data.map(validate);
    }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw Error('Histórico antigo inacessível; migração interrompida sem excluí-lo.');}
    const encrypted=await Promise.all(rows.map(row=>this.encrypt(row)));
    db.exec('BEGIN IMMEDIATE');
    try{
      const insert=db.prepare('INSERT OR IGNORE INTO records(id,account_key,kind,lookup_key,requested_at,status,payload) VALUES(?,?,?,?,?,?,?)');
      rows.forEach((row,i)=>insert.run(row.id,this.hash(row.account),row.kind??'person',this.identifierHash(row.account,row.kind??'person',row.kind==='company'?row.cnpj??'':row.cpf),row.requestedAt,row.status,encrypted[i]));
      db.prepare("INSERT INTO metadata(name,value) VALUES('legacy_migrated','1')").run();
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
  }
  private async lock<T>(fn:(db:DatabaseSync)=>Promise<T>):Promise<T>{
    if(this.closed)throw Error('Histórico encerrado; novas operações não são permitidas.');
    // A operação foi aceita antes do fechamento: deve concluir e persistir.
    const action=this.mutation.then(async()=>fn(await this.ensure(true)));
    this.mutation=action.then(()=>undefined,()=>undefined);
    return action;
  }
  private async allRows(db:DatabaseSync,account?:string,kind?:Kind):Promise<QueryRecord[]>{
    const rows=account
      ? (kind?db.prepare('SELECT id,payload FROM records WHERE account_key=? AND kind=? ORDER BY requested_at DESC').all(this.hash(account),kind):db.prepare('SELECT id,payload FROM records WHERE account_key=? ORDER BY requested_at DESC').all(this.hash(account)))
      : db.prepare('SELECT id,payload FROM records ORDER BY requested_at DESC').all();
    return Promise.all((rows as SqlRow[]).map(row=>this.decode(row)));
  }
  async list(account:string,kind?:Kind):Promise<QueryRecord[]>{return this.lock(db=>this.allRows(db,account,kind));}
  async listAll():Promise<QueryRecord[]>{return this.lock(db=>this.allRows(db));}
  private async getRow(db:DatabaseSync,id:string):Promise<QueryRecord>{
    const row=db.prepare('SELECT id,payload FROM records WHERE id=?').get(id) as SqlRow|undefined;
    if(!row)throw Error('Consulta não localizada no índice.');return this.decode(row);
  }
  private async update(id:string,change:(record:QueryRecord)=>void):Promise<void>{
    await this.lock(async db=>{
      const record=await this.getRow(db,id);change(record);
      const encrypted=await this.encrypt(record);
      db.prepare('UPDATE records SET status=?,payload=? WHERE id=?').run(record.status,encrypted,id);
    });
  }
  async findLatest(account:string,cpf:string,kind:Kind='person'):Promise<QueryRecord|null>{
    return this.lock(async db=>{
      const row=db.prepare('SELECT id,payload FROM records WHERE account_key=? AND kind=? AND lookup_key=? ORDER BY requested_at DESC LIMIT 1')
        .get(this.hash(account),kind,this.identifierHash(account,kind,cpf)) as SqlRow|undefined;
      return row?this.decode(row):null;
    });
  }
  async findById(account:string,id:string):Promise<QueryRecord|null>{
    if(!/^[a-f0-9-]{36}$/i.test(id))return null;
    return this.lock(async db=>{
      const row=db.prepare('SELECT id,payload FROM records WHERE id=? AND account_key=?').get(id,this.hash(account)) as SqlRow|undefined;
      return row?this.decode(row):null;
    });
  }
  private async insert(account:string,kind:Kind,cpf:string,cnpj?:string):Promise<QueryRecord>{
    const normalized=account.trim().toLowerCase();if(!normalized)throw Error('Conta inválida.');
    return this.lock(async db=>{
      const now=new Date().toISOString();const record:QueryRecord={id:randomUUID(),kind,account:normalized,cpf,cnpj,requestedAt:now,updatedAt:now,status:'uncertain',pdfPaths:[]};
      const cipher=await this.encrypt(record);
      db.prepare('INSERT INTO records(id,account_key,kind,lookup_key,requested_at,status,payload) VALUES(?,?,?,?,?,?,?)')
        .run(record.id,this.hash(normalized),kind,this.identifierHash(normalized,kind,cnpj??cpf),now,record.status,cipher);
      return structuredClone(record);
    });
  }
  async begin(account:string,cpf:string,kind:Kind='person'):Promise<QueryRecord>{if(!/^[0-9]{11}$/.test(cpf))throw Error('CPF inválido.');return this.insert(account,kind,cpf);}
  async findLatestCompany(account:string,cnpj:string):Promise<QueryRecord|null>{
    return this.lock(async db=>{
      const row=db.prepare('SELECT id,payload FROM records WHERE account_key=? AND kind=? AND lookup_key=? ORDER BY requested_at DESC LIMIT 1')
        .get(this.hash(account),'company',this.identifierHash(account,'company',cnpj)) as SqlRow|undefined;
      return row?this.decode(row):null;
    });
  }
  async beginCompany(account:string,cnpj:string):Promise<QueryRecord>{if(!/^[0-9]{14}$/.test(cnpj))throw Error('CNPJ inválido.');return this.insert(account,'company','',cnpj);}
  async setCode(id:string,queryCode:string):Promise<void>{
    if(!/^Q-[A-F0-9]{10}$/.test(queryCode))throw Error('Código de consulta inválido.');
    await this.update(id,row=>{row.queryCode=queryCode;row.status='pending';delete row.lastIssue;row.updatedAt=new Date().toISOString();});
  }
  async addPdf(id:string,path:string):Promise<void>{
    if(typeof path!=='string'||!path.toLowerCase().endsWith('.pdf'))throw Error('Caminho PDF inválido.');
    await this.update(id,row=>{if(!row.pdfPaths.includes(path))row.pdfPaths.push(path);row.status='ready';delete row.lastIssue;row.updatedAt=new Date().toISOString();});
  }
  async markPisUnavailable(id:string):Promise<void>{await this.update(id,row=>{
    if(row.kind!=='pis'||row.pdfPaths.length)throw Error('Registro PIS inválido para indisponibilidade.');
    row.status='pis_unavailable';row.lastIssue='Número de PIS não disponibilizado pela Deskdata nesta consulta. PDF não gerado.';row.updatedAt=new Date().toISOString();
  });}
  async setPending(id:string):Promise<void>{await this.update(id,row=>{if(!row.queryCode)throw Error('Registro sem código de recuperação.');row.status='pending';delete row.lastIssue;row.updatedAt=new Date().toISOString();});}
  async setPaused(id:string,reason:string):Promise<void>{await this.update(id,row=>{if(row.status==='ready')return;row.status='paused';row.lastIssue=reason.slice(0,180);row.updatedAt=new Date().toISOString();});}
  async markReady(id:string):Promise<void>{await this.update(id,row=>{row.status='ready';delete row.lastIssue;row.updatedAt=new Date().toISOString();});}
  async removePdfReferences(paths:ReadonlySet<string>):Promise<void>{
    if(!paths.size)return;
    await this.lock(async db=>{
      const rows=await this.allRows(db);const changes=[];
      for(const row of rows){const existing=row.pdfPaths.length;row.pdfPaths=row.pdfPaths.filter(p=>!paths.has(p));if(row.pdfPaths.length===existing)continue;
        if(!row.pdfPaths.length){row.status=row.queryCode?'paused':'uncertain';if(row.queryCode)row.lastIssue='PDF local removido. O resultado poderá ser recuperado pelo código, sem novo POST.';}
        row.updatedAt=new Date().toISOString();changes.push({row,encrypted:await this.encrypt(row)});
      }
      db.exec('BEGIN IMMEDIATE');try{const update=db.prepare('UPDATE records SET status=?,payload=? WHERE id=?');for(const {row,encrypted} of changes)update.run(row.status,encrypted,row.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
    });
  }
  async clearAll():Promise<void>{await this.lock(async db=>{db.prepare('DELETE FROM records').run();});}
  /** Snapshot consistente para backup, sem interromper consultas já persistidas. */
  async backupSnapshot():Promise<Buffer>{
    return this.lock(async db=>{
      const temp=join(this.directory,`snapshot-${randomUUID()}.sqlite`);
      try{await sqliteBackup(db,temp);return await readFile(temp);}finally{await unlink(temp).catch(()=>{});}
    });
  }
}

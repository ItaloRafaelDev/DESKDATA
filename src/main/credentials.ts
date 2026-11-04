import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/** Abstrai safeStorage para permitir testar sem acesso ao SO/segredos reais. */
export interface CredentialProtector {
  isAvailable():Promise<boolean>;
  encrypt(data:string):Promise<Buffer>;
  decrypt(data:Buffer):Promise<{result:string;shouldReEncrypt:boolean}>;
}
export interface SavedCredential {email:string;password:string}
export interface CredentialStatus {hasSaved:boolean}
export class CredentialStore {
  private readonly filePath:string;
  private readonly directory:string;
  private readonly protector:CredentialProtector;
  constructor(directory:string, protector:CredentialProtector) {
    this.directory=directory; this.protector=protector;
    this.filePath=join(directory,'credentials.bin');
  }
  async status():Promise<CredentialStatus>{
    try {await access(this.filePath);return {hasSaved:true};}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {hasSaved:false};throw new Error('Falha ao verificar credenciais protegidas.');}
  }
  async save(email:string,password:string):Promise<void>{
    if (!email.trim() || !password) throw new Error('Usuário e senha são obrigatórios para lembrar o acesso.');
    if (!await this.protector.isAvailable()) throw new Error('A proteção de credenciais do Windows está indisponível. Nenhuma senha foi salva.');
    const cipher=await this.protector.encrypt(JSON.stringify({version:1,email:email.trim(),password}));
    await mkdir(this.directory,{recursive:true});
    const tempFile=join(this.directory,`credentials.${randomUUID()}.tmp`);
    try {
      await writeFile(tempFile,cipher,{mode:0o600,flag:'wx'});
      await rename(tempFile,this.filePath);
    } catch(e) {
      await unlink(tempFile).catch(()=>{});
      throw new Error('Não foi possível salvar as credenciais protegidas.');
    }
  }
  async load():Promise<SavedCredential|null>{
    if(!(await this.status()).hasSaved)return null;
    if (!await this.protector.isAvailable()) throw new Error('A proteção de credenciais do Windows está indisponível.');
    try {
      const encrypted=await readFile(this.filePath);
      const decrypted=await this.protector.decrypt(encrypted);
      const parsed:unknown=JSON.parse(decrypted.result);
      if(!parsed || typeof parsed!=='object' || Array.isArray(parsed))throw new Error('Invalid payload');
      const v=parsed as Record<string,unknown>;
      if(v.version!==1 || typeof v.email!=='string'||!v.email||typeof v.password!=='string'||!v.password)throw new Error('Invalid credentials');
      const credentials={email:v.email,password:v.password};
      if(decrypted.shouldReEncrypt)await this.save(credentials.email,credentials.password);
      return credentials;
    } catch {
      throw new Error('Não foi possível recuperar as credenciais salvas. Você pode apagá-las e autenticar novamente.');
    }
  }
  async clear():Promise<void>{
    try {await unlink(this.filePath);}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('Não foi possível remover as credenciais salvas.');}
  }
}

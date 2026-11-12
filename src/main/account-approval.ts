import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { CredentialProtector } from './credentials.ts';

type Data = { version: 1; accounts: Record<string, boolean> };

/** Consentimento para novos POSTs, isolado por identidade e protegido em disco. */
export class AccountApprovalStore {
  private readonly path: string;
  private readonly directory: string;
  private readonly protector: CredentialProtector;
  private mutation: Promise<void> = Promise.resolve();
  constructor(directory: string, protector: CredentialProtector) {
    this.directory=directory; this.protector=protector;
    this.path = join(directory, 'credit-approvals.bin');
  }
  private key(account: string): string {
    if (typeof account !== 'string' || !account.trim()) throw new Error('Conta inválida para autorização.');
    return account.trim().toLowerCase();
  }
  private async read(): Promise<Data> {
    let encrypted: Buffer;
    try { encrypted = await readFile(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {version:1, accounts:{}};
      throw new Error('Não foi possível ler as autorizações locais.', { cause: error });
    }
    if (!await this.protector.isAvailable()) throw new Error('Proteção de autorizações indisponível.');
    try {
      const decrypted = await this.protector.decrypt(encrypted);
      const data: unknown = JSON.parse(decrypted.result);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Invalid');
      const record = data as Record<string, unknown>;
      const accounts = record.accounts;
      if (record.version !== 1 || !accounts || typeof accounts !== 'object' || Array.isArray(accounts)
        || !Object.values(accounts).every(value => typeof value === 'boolean')) throw Error('Invalid');
      return {version:1,accounts:accounts as Record<string,boolean>};
    } catch { throw new Error('Índice de autorizações corrompido ou indisponível. Novas consultas estão bloqueadas.'); }
  }
  async isApproved(account: string): Promise<boolean> {
    await this.mutation;
    return (await this.read()).accounts[this.key(account)] === true;
  }
  async setApproved(account: string, approved: boolean): Promise<void> {
    if (typeof approved !== 'boolean') throw new Error('Autorização inválida.');
    const key = this.key(account);
    const job = this.mutation.then(async () => {
      const data = await this.read();
      data.accounts[key] = approved;
      if (!await this.protector.isAvailable()) throw new Error('Proteção de autorizações indisponível.');
      const encrypted = await this.protector.encrypt(JSON.stringify(data));
      await mkdir(this.directory,{recursive:true});
      const temp = join(this.directory,`credit-approvals.${randomUUID()}.tmp`);
      try {
        await writeFile(temp,encrypted,{flag:'wx',mode:0o600});
        await rename(temp,this.path);
      } catch {
        await unlink(temp).catch(()=>{});
        throw new Error('Falha ao registrar a autorização desta conta.');
      }
    });
    this.mutation = job.then(()=>undefined,()=>undefined);
    await job;
  }
}

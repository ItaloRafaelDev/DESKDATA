import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { crc32, deflateRaw } from 'node:zlib';
import type { QueryHistoryStore } from './query-history.ts';
import type { CredentialProtector } from './credentials.ts';
import type { AppSettings } from '../shared/types.ts';

const deflateRawAsync=promisify(deflateRaw);
/**
 * Formato ZIP padrão (DEFLATE), sem dependências; armazena somente arquivos protegidos.
 * P7 (E5): a compressão roda no pool de threads do zlib e o CRC é nativo, para não travar o processo principal.
 */
export async function createZip(entries:ReadonlyArray<{name:string;data:Buffer}>):Promise<Buffer>{
  for(const entry of entries){
    if(!/^[a-zA-Z0-9_.-]{1,64}$/.test(entry.name))throw Error('Nome de arquivo ZIP inválido.');
    if(entry.data.length>100*1024*1024)throw Error('Arquivo excede 100 MB.');
  }
  const locals:Buffer[]=[];const central:Buffer[]=[];let offset=0;
  for(const entry of entries){
    const filename=Buffer.from(entry.name,'utf8');const data=await deflateRawAsync(entry.data);const checksum=crc32(entry.data);
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x0800,6);header.writeUInt16LE(8,8);
    header.writeUInt32LE(checksum,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(entry.data.length,22);header.writeUInt16LE(filename.length,26);
    locals.push(header,filename,data);
    const dir=Buffer.alloc(46);dir.writeUInt32LE(0x02014b50);dir.writeUInt16LE(20,4);dir.writeUInt16LE(20,6);dir.writeUInt16LE(0x0800,8);dir.writeUInt16LE(8,10);
    dir.writeUInt32LE(checksum,16);dir.writeUInt32LE(data.length,20);dir.writeUInt32LE(entry.data.length,24);dir.writeUInt16LE(filename.length,28);dir.writeUInt32LE(offset,42);
    central.push(dir,filename);offset+=header.length+filename.length+data.length;
  }
  const directory=Buffer.concat(central);const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}
export class BackupService {
  private readonly options:{userData:string;backupDirectory:string;history:QueryHistoryStore;protector:CredentialProtector;getSettings:()=>Promise<AppSettings>};
  constructor(options:{userData:string;backupDirectory:string;history:QueryHistoryStore;protector:CredentialProtector;getSettings:()=>Promise<AppSettings>}){this.options=options;}
  get directory():string{return this.options.backupDirectory;}
  /** Reentrada impedida pelo OperationGate (canal exclusivo `backup:create`), sem flag local. */
  async create():Promise<{path:string;size:number;createdAt:string}>{
    {
      if(!await this.options.protector.isAvailable())throw Error('Proteção de dados do Windows não está disponível. Backup cancelado.');
      const [snapshot,settings,records]=await Promise.all([this.options.history.backupSnapshot(),this.options.getSettings(),this.options.history.listAll()]);
      const key=await readFile(join(this.options.userData,'history-key.bin'));
      const state=await readFile(join(this.options.userData,'history-state.flag'));
      let approvals:Buffer|undefined;
      try{approvals=await readFile(join(this.options.userData,'credit-approvals.bin'));}
      catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      const settingsCipher=await this.options.protector.encrypt(JSON.stringify({outputFolder:settings.outputFolder}));
      const components=[{name:'history.sqlite',data:snapshot},{name:'history-key.bin',data:key},{name:'history-state.flag',data:state},{name:'settings.bin',data:settingsCipher}];
      if(approvals)components.push({name:'credit-approvals.bin',data:approvals});
      // Copias das reservas e da fila CPI, ambas cifradas pela conta do Windows.
      // Nunca incluir CPFs, respostas de API, PDFs ou cookies da sessao do navegador.
      for(const filename of ['cpi-automatic-budget.bin','cpi-workflows.bin']){
        try{const protectedData=await readFile(join(this.options.userData,filename));
          components.push({name:filename,data:protectedData});}
        catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      }
      const createdAt=new Date().toISOString();
      const manifest={format:'deskdata-backup-v1',createdAt,recordCount:records.length,
        files:components.map(item=>({name:item.name,size:item.data.length,sha256:createHash('sha256').update(item.data).digest('hex')})),
        note:'Dados protegidos pela conta Windows de origem. Não contém PDFs ou credenciais de login.'};
      const data=await createZip([{name:'manifest.json',data:Buffer.from(JSON.stringify(manifest,null,2))},...components]);
      await mkdir(this.directory,{recursive:true});
      const filename=`DESKDATA_BACKUP_${createdAt.replace(/[:.]/g,'-')}.zip`;
      const file=join(this.directory,filename);const temp=`${file}.${randomUUID()}.tmp`;
      try{await writeFile(temp,data,{mode:0o600,flag:'wx'});await rename(temp,file);}catch(e){await unlink(temp).catch(()=>{});throw e;}
      return {path:file,size:data.length,createdAt};
    }
  }
}

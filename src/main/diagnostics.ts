import { appendFile, mkdir, readdir, stat, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TIMED_FLOWS, TIMED_OUTCOMES, TIMED_STEPS } from './step-timing.ts';

/** Registro operacional intencionalmente sem payload, CPF, CNPJ, e-mail, senha ou token. */
export class DiagnosticLogger {
  private readonly directory:string;
  private queue:Promise<void>=Promise.resolve();
  constructor(directory:string){this.directory=directory;}
  async write(event:string,fields:Record<string,unknown>={}):Promise<void>{
    // Somente eventos e chaves de diagnóstico predefinidas; campos livres nunca vão ao disco.
    const allowed=new Set(['channel','durationMs','state','errorType','httpStatus','attempts','count','flow','correlationId','step','outcome']);
    const safe:Record<string,string|number>={};
    for(const [key,value] of Object.entries(fields)){
      if(!allowed.has(key))continue;
      if(key==='flow' && (TIMED_FLOWS as readonly unknown[]).includes(value))safe[key]=value as string;
      else if(key==='step' && (TIMED_STEPS as readonly unknown[]).includes(value))safe[key]=value as string;
      else if(key==='outcome' && (TIMED_OUTCOMES as readonly unknown[]).includes(value))safe[key]=value as string;
      else if(key==='correlationId' && typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))safe[key]=value;
      else if(key==='channel' && typeof value==='string' && /^[a-z][a-z0-9-]{0,31}(?::[a-z][a-z0-9-]{0,31}){1,2}$/i.test(value))safe[key]=value;
      else if(key==='state' && typeof value==='string' && /^(pending|ready|paused|success|failed|cancelled)$/.test(value))safe[key]=value;
      else if(key==='errorType' && typeof value==='string' && /^[A-Za-z]{1,45}Error$/.test(value))safe[key]=value;
      else if(['durationMs','httpStatus','attempts','count'].includes(key) && typeof value==='number' && Number.isFinite(value) && value>=0)safe[key]=Math.round(value);
    }
    const type=/^[a-z][a-z0-9_]{1,50}$/.test(event)?event:'unknown_event';
    const entry=JSON.stringify({at:new Date().toISOString(),level:type.includes('error')?'error':'info',event:type,...safe})+'\n';
    const job=this.queue.then(async()=>{
      await mkdir(this.directory,{recursive:true});
      const filename=`app-${new Date().toISOString().slice(0,10)}.jsonl`;
      const path=join(this.directory,filename);
      const size=await stat(path).then(v=>v.size).catch(e=>{
        if((e as NodeJS.ErrnoException).code==='ENOENT')return 0;throw e;
      });
      if(size>5*1024*1024)await rename(path,join(this.directory,`app-${randomUUID()}.jsonl`));
      await appendFile(path,entry,{mode:0o600});
      const all=(await readdir(this.directory)).filter(n=>/^app-.*\.jsonl$/.test(n)).sort();
      const rows=await Promise.all(all.map(async name=>({name,mtime:(await stat(join(this.directory,name))).mtimeMs})));
      rows.sort((a,b)=>b.mtime-a.mtime);
      await Promise.all(rows.slice(5).map(row=>unlink(join(this.directory,row.name))));
    });
    this.queue=job.catch(()=>{});
    await job;
  }
}

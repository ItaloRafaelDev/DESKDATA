import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { QueryHistoryStore } from '../../src/main/query-history.ts';

/** Executa os handlers reais sem iniciar Electron, navegador ou conexão externa. */
export async function withMainProcess(submitCpf,run,options={}){
  const root=await mkdtemp(join(tmpdir(),'deskdata-main-integrity-'));
  const stores=[],handlers=new Map(),listeners=new Map(),events=[],diagnostics=[];
  const sourceUrl=new URL('../../src/main/index.ts',import.meta.url);
  const localRequire=createRequire(sourceUrl);
  let initialize,window,renderCount=0,quitting=false,failedClose=false;
  const emit=(name,...args)=>{for(const fn of listeners.get(name)??[])fn(...args);};
  const quit=()=>{
    let prevented=false;
    emit('before-quit',{preventDefault:()=>{prevented=true;}});
    if(!prevented){quitting=true;events.push('quit');}
  };
  const electron={
    app:{getPath:()=>root,setPath:()=>{},requestSingleInstanceLock:()=>true,
      on:(name,fn)=>{listeners.set(name,[...(listeners.get(name)??[]),fn]);},quit,
      isPackaged:true,whenReady:()=>({then:fn=>{initialize=Promise.resolve().then(fn);return initialize;}})},
    BrowserWindow:class {
      constructor(){window=this;this.webContents={id:1,mainFrame:{},send:()=>{},isDestroyed:()=>false,
        setWindowOpenHandler:()=>{},on:()=>{}};}
      once(){} on(){} isDestroyed(){return false;} loadFile(){return Promise.resolve();}
    },
    ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},
    safeStorage:{isAsyncEncryptionAvailable:async()=>true,encryptStringAsync:async s=>Buffer.from(s),
      decryptStringAsync:async b=>({result:b.toString(),shouldReEncrypt:false})},
    session:{defaultSession:{setPermissionRequestHandler:()=>{}}},
    dialog:{showMessageBox:options.showMessageBox??(async()=>({response:0}))},shell:{}
  };
  const stubs={
    electron,
    ...(options.shutdownTimeoutMs?{'./operations.ts':{
      ...localRequire('./operations.ts'),
      ApplicationOperations:class extends localRequire('./operations.ts').ApplicationOperations {
        waitForIdle(additional){return super.waitForIdle(additional,options.shutdownTimeoutMs);}
      }
    }}:{}),
    './query-history.ts':{QueryHistoryStore:class extends QueryHistoryStore {
      constructor(...args){super(...args);stores.push(this);}
      async setCode(...args){await super.setCode(...args);events.push('code_persisted');}
      async close(){
        events.push('database_close');
        if(options.failDatabaseCloseOnce && !failedClose){failedClose=true;throw new Error('Falha simulada ao fechar SQLite');}
        return super.close();
      }
    },assertQueryRecordIdentity:localRequire('./query-history.ts').assertQueryRecordIdentity},
    ...(options.beforeApproval?{'./account-approval.ts':{
      AccountApprovalStore:class extends localRequire('./account-approval.ts').AccountApprovalStore {
        async isApproved(...args){await options.beforeApproval();return super.isApproved(...args);}
      }
    }}:{}),
    './deskdata-client.ts':{DeskdataClient:class {
      async authenticate(){} reset(){events.push('session_reset');} async credits(){return options.credits?options.credits():20;}
      submitCpf(cpf,onCode){return submitCpf(cpf,onCode);}
      submitCompany(cnpj,onCode){return submitCpf(cnpj,onCode);}
      queryBasicCpf(cpf,onCode){return submitCpf(cpf,onCode);}
    }},
    './cpi/cpi-browser.ts':{CpiBrowser:class {
      async close(){} status(){return {state:options.cpiOpen?'open':'closed'};}
      async filterPendingPerson29(){return options.filter?options.filter():{state:'empty',total:0,typeId:'29'};}
      async inspectPersistedPersonResponse(...args){return options.inspectPersisted?options.inspectPersisted(...args):'unavailable';}
    }},
    './pending-queries.ts':{PendingQueryMonitor:class {
      tasks=new Set();stopAll(){this.tasks.clear();}isWatching(id){return this.tasks.has(id);}watch(target){events.push('query_watch');this.tasks.add(target.id);}
    }},
    './settings.ts':{getSettings:async()=>options.getSettings?options.getSettings(root):({outputFolder:root,paidQueriesApproved:false})},
    ...(options.maintenance?{'./maintenance.ts':{MaintenanceService:class {
      async preview(){return {recordCount:0,pdfCount:0,pendingCount:0};}
      clean(selection){return options.maintenance(selection);}
    }}}:{}),
    './pdf.ts':{saveReportPdf:async(_folder,report)=>({path:join(root,`RELATORIO_${report.cpf}_${++renderCount}.pdf`),
      queryCode:report.queryCode,savedAt:'2026-11-11T00:00:00Z'})},
    './diagnostics.ts':{DiagnosticLogger:class {async write(event,fields={}){diagnostics.push({event,...fields});}}}
  };
  try{
    const source=(await readFile(sourceUrl,'utf8')).replaceAll('import.meta.url',JSON.stringify(sourceUrl.href));
    const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    runInNewContext(compiled,{exports:{},require:name=>Object.hasOwn(stubs,name)?stubs[name]:localRequire(name),
      performance,console,process:{env:{}},URL,setTimeout,clearTimeout});
    await initialize;
    const invoke=(channel,...args)=>{
      const handler=handlers.get(channel);
      if(!handler)throw new Error(`Handler não inicializado: ${channel}`);
      return handler({sender:window.webContents,senderFrame:window.webContents.mainFrame},...args);
    };
    await invoke('auth:login','ipc-tests@example.invalid','fictitious-password',false);
    await invoke('settings:approve',true);
    await run({invoke,root,renderCount:()=>renderCount,requestQuit:quit,events,diagnostics,
      allWindowsClosed:()=>emit('window-all-closed'),hasQuit:()=>quitting,
      reopenHistory:async()=>{
        const store=new QueryHistoryStore(root,{isAvailable:async()=>true,encrypt:async s=>Buffer.from(s),
          decrypt:async b=>({result:b.toString(),shouldReEncrypt:false})});
        try{return await store.list('ipc-tests@example.invalid');}finally{await store.close();}
      }});
    if(!quitting)await invoke('auth:logout');
  }finally{
    if(handlers.has('cpi:auto:pause') && !quitting){
      await handlers.get('cpi:auto:pause')({sender:window.webContents,senderFrame:window.webContents.mainFrame}).catch(()=>{});
    }
    await Promise.all(stores.map(store=>store.close()));
    await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
}

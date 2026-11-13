import { app, dialog } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AppSettings } from '../shared/types.ts';

const defaults: AppSettings = {outputFolder:null,paidQueriesApproved:false};
const settingsPath=():string=>join(app.getPath('userData'),'settings.json');
export async function getSettings():Promise<AppSettings>{
  try {
    const parsed=JSON.parse(await readFile(settingsPath(),'utf8')) as Partial<AppSettings>;
    return {outputFolder:typeof parsed.outputFolder==='string'?parsed.outputFolder:null,paidQueriesApproved:false};
  } catch(err){
    if((err as NodeJS.ErrnoException).code==='ENOENT')return {...defaults};
    throw new Error('Não foi possível ler as configurações locais.',{cause:err});
  }
}
export async function saveSettings(value:AppSettings):Promise<void>{
  await mkdir(dirname(settingsPath()),{recursive:true});
  await writeFile(settingsPath(),JSON.stringify({outputFolder:value.outputFolder,paidQueriesApproved:false},null,2),'utf8');
}
/** Só o diálogo: espera humana, sem bloqueio exclusivo (E3/W25). `null` quando cancelado. */
export async function pickOutputFolder():Promise<string|null>{
  const choice=await dialog.showOpenDialog({properties:['openDirectory','createDirectory'],title:'Selecionar pasta dos relatórios PDF'});
  return choice.canceled||!choice.filePaths[0]?null:choice.filePaths[0];
}
export async function saveOutputFolder(folder:string):Promise<AppSettings>{
  const state=await getSettings();state.outputFolder=folder;
  await saveSettings(state);return state;
}

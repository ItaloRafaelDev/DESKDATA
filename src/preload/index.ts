import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, QueryUpdate, CpiMonitorSnapshot, CpiAutoSnapshot } from '../shared/types.ts';
import { IPC_EVENTS, IPC_INVOKE, type InvokeMethod } from '../shared/ipc-contract.ts';

// Canais vêm só do contrato (E5); o renderer recebe apenas os métodos tipados do DesktopApi.
const invokers=Object.fromEntries((Object.keys(IPC_INVOKE) as InvokeMethod[]).map(method=>
  [method,(...args:unknown[])=>ipcRenderer.invoke(IPC_INVOKE[method],...args)]
)) as Pick<DesktopApi,InvokeMethod>;

function subscribe<T>(channel:string,callback:(value:T)=>void):()=>void{
  const listener=(_event:Electron.IpcRendererEvent,value:T)=>callback(value);
  ipcRenderer.on(channel,listener);
  return ()=>ipcRenderer.removeListener(channel,listener);
}

const api:DesktopApi={
  ...invokers,
  subscribeCpiAuto:callback=>subscribe<CpiAutoSnapshot>(IPC_EVENTS.cpiAuto,callback),
  subscribeCpiMonitor:callback=>subscribe<CpiMonitorSnapshot>(IPC_EVENTS.cpiMonitor,callback),
  subscribeQueryUpdates:callback=>subscribe<QueryUpdate>(IPC_EVENTS.queryUpdates,callback)
};
contextBridge.exposeInMainWorld('deskdata',api);

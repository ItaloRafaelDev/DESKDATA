import { useEffect, type ReactNode } from 'react';
import { notificationDuration, type NoticeKind } from './ux.ts';

export type IconName = 'user'|'file'|'id'|'building'|'settings'|'check'|'close'|'info'|'alert'|'folder'|'shield'|'logout'|'refresh'|'bell'|'arrow';
const paths:Record<IconName,ReactNode>={
 user:<><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></>,
 file:<><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 9h8M8 13h8M8 17h5"/></>,
 id:<><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M6.5 16c1-2 4-2 5 0M14 10h4M14 14h4"/></>,
 building:<><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 21v-5h6v5M8 7h1M15 7h1M8 11h1M15 11h1"/></>,
 settings:<><circle cx="12" cy="12" r="3"/><path d="M10 2h4l.5 2.5 2 1 2.4-1 2.2 3.7-1.9 1.7v2.3l1.9 1.7-2.2 3.7-2.4-1-2 1L14 22h-4l-.5-2.5-2-1-2.4 1-2.2-3.7 1.9-1.7v-2.3L2.9 10l2.2-3.7 2.4 1 2-1z"/></>,
 check:<path d="m5 12 5 5L20 7"/>,
 close:<path d="M18 6 6 18M6 6l12 12"/>,
 info:<><circle cx="12" cy="12" r="10"/><path d="M12 11v6M12 7h.01"/></>,
 alert:<><path d="m12 3 10 18H2L12 3z"/><path d="M12 10v4M12 17h.01"/></>,
 folder:<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>,
 shield:<><path d="m12 2 8 4v6c0 5-3 8-8 10-5-2-8-5-8-10V6z"/><path d="m9 12 2 2 4-4"/></>,
 logout:<><path d="M9 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></>,
 refresh:<><path d="M20 8a8 8 0 0 0-14-3L4 8M4 3v5h5M4 16a8 8 0 0 0 14 3l2-3M20 21v-5h-5"/></>,
 bell:<><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></>,
 arrow:<path d="M5 12h14m-7-7 7 7-7 7"/>
};
export function Icon({name,size=18}: {name:IconName;size?:number}){
  return <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
export interface Notification {id:number;text:string;type:NoticeKind}
export function ToastHost({notice,onDismiss}:{notice:Notification|null;onDismiss:()=>void}){
  useEffect(()=>{
    if(!notice)return;
    const timer=window.setTimeout(onDismiss,notificationDuration(notice.type));
    return ()=>window.clearTimeout(timer);
  },[notice?.id,onDismiss]);
  if(!notice)return null;
  return <div className="notification-region" aria-live={notice.type==='error'?'assertive':'polite'}>
    <div className={`notification ${notice.type}`} role={notice.type==='error'?'alert':'status'}>
      <div className="notification-icon"><Icon name={notice.type==='success'?'check':notice.type==='error'?'alert':'info'} size={18}/></div>
      <div className="notification-body"><strong>{notice.type==='success'?'Operação concluída':notice.type==='error'?'Atenção':'Informação'}</strong><p>{notice.text}</p></div>
      <button type="button" aria-label="Fechar notificação" className="notification-close" onClick={onDismiss}><Icon name="close" size={17}/></button>
    </div>
  </div>;
}

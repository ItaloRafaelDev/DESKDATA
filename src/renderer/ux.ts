import type { DesktopApi } from '../shared/types.ts';

type LoginStore = Pick<DesktopApi, 'credentialsStatus'|'loadSavedCredentials'>;
export type NoticeKind = 'success' | 'error' | 'info';

/** Só consulta a senha protegida quando o usuário optou por lembrá-la anteriormente. */
export async function loadRememberedLogin(store:LoginStore):Promise<{email:string;password:string}|null>{
  const status=await store.credentialsStatus();
  if(!status.hasSaved)return null;
  return store.loadSavedCredentials();
}
export function notificationDuration(kind:NoticeKind):number{
  return kind==='error'?9000:kind==='info'?6000:4500;
}

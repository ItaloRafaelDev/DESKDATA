import { DATASETS } from '../shared/types.ts';
import { readResponseLimited } from './http-response.ts';
import { COMPANY_DATASETS } from '../shared/company-report.ts';
import { cancellableDelay, isDeadlineError, withDeadline } from './deadline.ts';

const ROOT = 'https://api.deskdata.com.br';
interface ApiResponse { status?: {code?: number; message?: string}; data?: unknown; query?: {code?: string}; query_code?: string }
type Fetcher = typeof fetch;
export type QueryCheck = {state:'pending';queryCode:string} | {state:'ready';queryCode:string;payload:unknown};
export type QueryStart = {state:'pending';queryCode:string} | {state:'ready';queryCode?:string;payload:unknown};

function asObj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}
function errorCode(payload: ApiResponse, status: number): string {
  const code = payload.status?.code;
  if (status === 401) return 'Sessão expirada ou credenciais inválidas. Entre novamente.';
  if (status === 403 && code === 4003) return 'Créditos insuficientes para a consulta.';
  if (status === 404 && code === 4009) return 'Código de consulta não encontrado pela API.';
  if (status === 403) return 'Consulta bloqueada ou acesso não autorizado.';
  if (status === 400) return `Dados da requisição rejeitados pela API (código ${code ?? status}).`;
  if (status >= 500) return 'Serviço Deskdata indisponível. Não repita a consulta automaticamente.';
  return `A Deskdata retornou um estado inesperado (HTTP ${status}; código ${code ?? 'não informado'}).`;
}
export function extractQueryCode(payload:ApiResponse):string|undefined {
  const code = payload.query_code ?? payload.query?.code;
  return typeof code === 'string' && /^Q-[A-F0-9]{10}$/.test(code) ? code : undefined;
}
/** Limite por requisição HTTP e prazo total do polling por código (E3). */
export const DESKDATA_REQUEST_TIMEOUT_MS = 35_000;
export const DESKDATA_POLL_DEADLINE_MS = 180_000;
export interface DeskdataClientOptions { timeoutMs?: number; pollDeadlineMs?: number; now?: () => number }
const SESSION_ENDED = 'Sessão Deskdata encerrada durante a requisição. Não repita automaticamente: a consulta pode ter sido recebida.';

export class DeskdataClient {
  private token: string | null = null;
  private expiresAt = 0;
  private readonly fetcher: Fetcher;
  private readonly sleep: (milliseconds:number, signal?:AbortSignal)=>Promise<void>;
  private readonly timeoutMs: number;
  private readonly pollDeadlineMs: number;
  private readonly now: () => number;
  /** Abortado por `reset()` (logout, troca de conta, encerramento): cancela requisições e esperas em curso. */
  private session = new AbortController();
  constructor(fetcher: Fetcher = fetch, sleep: (milliseconds:number, signal?:AbortSignal)=>Promise<void> = cancellableDelay, options: DeskdataClientOptions = {}) {
    this.fetcher = fetcher; this.sleep = sleep;
    this.timeoutMs = options.timeoutMs ?? DESKDATA_REQUEST_TIMEOUT_MS;
    this.pollDeadlineMs = options.pollDeadlineMs ?? DESKDATA_POLL_DEADLINE_MS;
    this.now = options.now ?? (() => Date.now());
  }
  reset(): void { this.token = null; this.expiresAt = 0; this.session.abort(); this.session = new AbortController(); }
  private validToken(): string {
    if (!this.token || Date.now() >= this.expiresAt - 60_000) {
      throw new Error('Sessão não autenticada ou expirada. Entre novamente.');
    }
    return this.token;
  }
  private async call(method: 'GET'|'POST', path: string, body?: unknown, authorized=true): Promise<{httpStatus:number; body:ApiResponse}> {
    const token = authorized ? this.validToken() : null;
    const session = this.session.signal;
    if (session.aborted) throw new Error(SESSION_ENDED);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    const timer = setTimeout(abort, this.timeoutMs);
    session.addEventListener('abort', abort, { once: true });
    try {
      const exchange = (async () => {
        const response = await this.fetcher(`${ROOT}${path}`, {
          method, redirect: 'error', signal: controller.signal,
          headers: { 'Accept': 'application/json', ...(body===undefined?{}:{'Content-Type':'application/json'}), ...(token?{'Authorization':`Bearer ${token}`}:{}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        return { response, raw: await readResponseLimited(response, 8_000_000) };
      })();
      // Mesmo um transporte que ignore o AbortSignal não prende a chamada além do prazo.
      const { response, raw } = await withDeadline(exchange, this.timeoutMs + 1_000, 'deskdata_http', abort);
      let parsed: ApiResponse;
      try { parsed = JSON.parse(raw) as ApiResponse; } catch { throw new Error('A API não retornou JSON válido.'); }
      if (!response.ok && response.status !== 202) throw new Error(errorCode(parsed, response.status));
      return {httpStatus:response.status, body:parsed};
    } catch (err) {
      if (session.aborted) throw new Error(SESSION_ENDED, { cause: err });
      if (path === '/queries' && err instanceof TypeError) {
        throw new Error('Falha de rede durante a consulta. A requisição pode ter sido recebida: não repita automaticamente.', { cause: err });
      }
      if ((err as Error).name === 'AbortError' || isDeadlineError(err)) {
        throw new Error('Tempo limite de resposta. Não repita automaticamente: a consulta pode ter sido recebida e cobrada.', { cause: err });
      }
      throw err;
    } finally { clearTimeout(timer); session.removeEventListener('abort', abort); }
  }
  async authenticate(username: string, password: string): Promise<void> {
    if (username.trim().length < 3 || !password) throw new Error('Informe e-mail e senha da plataforma.');
    this.reset();
    const {body} = await this.call('POST','/auth',{username:username.trim(),password,expires_in:1},false);
    const obj = asObj(body.data);
    if (body.status?.code !== 2000 || typeof obj?.access_token !== 'string' || typeof obj.expires_at !== 'string') {
      throw new Error('Falha ao autenticar na Deskdata. Confira as credenciais.');
    }
    const expires = Date.parse(obj.expires_at);
    if (!Number.isFinite(expires) || expires <= Date.now() + 60_000) throw new Error('A API retornou um prazo de token inválido.');
    this.token = obj.access_token;
    this.expiresAt = expires;
  }
  async credits(): Promise<number> {
    const {body} = await this.call('GET','/credits');
    const obj = asObj(body.data);
    const balance = obj?.balance;
    if (body.status?.code !== 3000 || typeof balance !== 'number' || !Number.isFinite(balance)) {
      throw new Error('Não foi possível validar o saldo de créditos.');
    }
    return balance;
  }
  /**
   * Polling por GET (nunca POST): no máximo 24 tentativas e prazo total de `pollDeadlineMs`; a espera entre
   * tentativas é cancelada por `reset()`. Ao esgotar, o código continua recuperável depois por GET.
   */
  private async awaitResult(code:string):Promise<{payload:unknown;queryCode:string}>{
    const session = this.session.signal;
    const deadline = this.now() + this.pollDeadlineMs;
    for (let attempt=0;attempt<24 && this.now()+5000<=deadline;attempt++) {
      await this.sleep(5000, session);
      if (session.aborted) throw new Error(SESSION_ENDED);
      const polled = await this.call('GET',`/queries/${encodeURIComponent(code)}`);
      if (polled.httpStatus === 200 && polled.body.status?.code === 4000) return {payload:polled.body,queryCode:code};
      if (polled.httpStatus !== 202 || polled.body.status?.code !== 4008) throw new Error(errorCode(polled.body,polled.httpStatus));
    }
    throw new Error(`Consulta ainda em processamento (${code}). Recupere-a posteriormente sem criar nova consulta.`);
  }
  async fetchByCode(code:string):Promise<{payload:unknown;queryCode:string}>{
    if(typeof code!=='string'||!/^Q-[A-F0-9]{10}$/.test(code))throw new Error('Código de consulta inválido.');
    const first=await this.call('GET',`/queries/${encodeURIComponent(code)}`);
    if(first.httpStatus===200 && first.body.status?.code===4000)return {payload:first.body,queryCode:code};
    if(first.httpStatus!==202 || first.body.status?.code!==4008)throw new Error(errorCode(first.body,first.httpStatus));
    return this.awaitResult(code);
  }
  // Consulta rápida: devolve HTTP 202 para o monitor, sem aguardar dentro do IPC.
  async checkByCode(code:string):Promise<QueryCheck>{
    if(typeof code!=='string'||!/^Q-[A-F0-9]{10}$/.test(code))throw new Error('Código de consulta inválido.');
    const result=await this.call('GET',`/queries/${encodeURIComponent(code)}`);
    if(result.httpStatus===202&&result.body.status?.code===4008)return {state:'pending',queryCode:code};
    if(result.httpStatus===200&&result.body.status?.code===4000)return {state:'ready',queryCode:code,payload:result.body};
    throw new Error(errorCode(result.body,result.httpStatus));
  }
  async submitCpf(cpf:string,onCode?:(code:string)=>void|Promise<void>):Promise<QueryStart>{
    return this.submitKey('persons','cpf',cpf,[...DATASETS],onCode);
  }
  async submitCompany(cnpj:string,onCode?:(code:string)=>void|Promise<void>):Promise<QueryStart>{
    if(typeof cnpj!=='string'||!/^[0-9]{14}$/.test(cnpj))throw new Error('CNPJ inválido.');
    return this.submitKey('companies','cnpj',cnpj,[...COMPANY_DATASETS],onCode);
  }
  private async submitKey(type:'persons'|'companies',keyType:'cpf'|'cnpj',keyValue:string,datasets:string[],onCode?:(code:string)=>void|Promise<void>):Promise<QueryStart>{
    const {httpStatus,body}=await this.call('POST','/queries',{type,key_type:keyType,key_value:keyValue,datasets});
    const queryCode=extractQueryCode(body);
    if(queryCode)await onCode?.(queryCode);
    if(httpStatus===200&&body.status?.code===4000)return {state:'ready',payload:body,queryCode};
    if(httpStatus===202&&body.status?.code===4008){
      if(!queryCode)throw new Error('Consulta pendente sem código recuperável. Nenhum novo POST será realizado.');
      return {state:'pending',queryCode};
    }
    throw new Error(errorCode(body,httpStatus));
  }
  async queryCpf(cpf: string, onPending?: (code: string)=>void|Promise<void>): Promise<{payload:unknown;queryCode?:string}> {
    return this.queryWithDatasets(cpf,[...DATASETS],onPending);
  }
  async queryBasicCpf(cpf:string,onPending?:(code:string)=>void|Promise<void>):Promise<{payload:unknown;queryCode?:string}> {
    return this.queryWithDatasets(cpf,['basic'],onPending);
  }
  async queryCompany(cnpj:string,onPending?:(code:string)=>void|Promise<void>):Promise<{payload:unknown;queryCode?:string}>{
    if(typeof cnpj!=='string'||!/^\d{14}$/.test(cnpj))throw new Error('CNPJ inválido.');
    return this.queryWithKey('companies','cnpj',cnpj,[...COMPANY_DATASETS],onPending);
  }
  private async queryWithDatasets(cpf:string,datasets:string[],onPending?:(code:string)=>void|Promise<void>):Promise<{payload:unknown;queryCode?:string}> {
    return this.queryWithKey('persons','cpf',cpf,datasets,onPending);
  }
  private async queryWithKey(type:'persons'|'companies',keyType:'cpf'|'cnpj',keyValue:string,datasets:string[],onPending?:(code:string)=>void|Promise<void>):Promise<{payload:unknown;queryCode?:string}> {
    const result = await this.call('POST','/queries',{
      type, key_type:keyType, key_value:keyValue, datasets
    });
    const payload=result.body;
    const code=extractQueryCode(payload);
    if(result.httpStatus===200 && payload.status?.code===4000){
      if(code)await onPending?.(code);
      return {payload,queryCode:code};
    }
    if(result.httpStatus!==202 || payload.status?.code!==4008)throw new Error(errorCode(payload,result.httpStatus));
    if(!code)throw new Error('Consulta pendente sem código recuperável. Não envie um novo POST automaticamente.');
    await onPending?.(code);
    return this.awaitResult(code);
  }
}

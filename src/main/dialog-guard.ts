import { runWithDeadline } from './deadline.ts';

/** Prazo para o usuário responder a uma confirmação destrutiva; sem resposta, vale "Cancelar" (E3/W24). */
export const CONFIRM_DIALOG_TIMEOUT_MS = 120_000;

/**
 * Diálogos nativos não podem prender operações nem o encerramento. Confirmação só vale com a resposta explícita
 * dentro do prazo; prazo esgotado ou encerramento do aplicativo fecham o diálogo e equivalem a cancelar.
 */
export class DialogGuard {
  private shutdown = new AbortController();
  private readonly timeoutMs: number;
  constructor(timeoutMs = CONFIRM_DIALOG_TIMEOUT_MS) { this.timeoutMs = timeoutMs; }

  /** `show` recebe o sinal que fecha o diálogo (Electron `showMessageBox({ signal })`). */
  async confirm(show: (signal: AbortSignal) => Promise<{ response: number }>, confirmId: number): Promise<boolean> {
    try {
      const answer = await runWithDeadline('dialog_confirm', this.timeoutMs, show, this.shutdown.signal);
      return answer.response === confirmId;
    } catch (error) {
      const name = error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
      if (name === 'TimeoutError' || name === 'AbortError') return false;
      throw error;
    }
  }

  /**
   * Para diálogos sem cancelamento nativo (ex.: seleção de pasta): devolve `null` se o aplicativo começar a encerrar.
   * O diálogo pode continuar na tela, mas o resultado tardio é descartado e nada é gravado.
   */
  untilShutdown<T>(work: Promise<T>): Promise<T | null> {
    const signal = this.shutdown.signal;
    if (signal.aborted) { work.catch(() => undefined); return Promise.resolve(null); }
    let onAbort: () => void = () => undefined;
    const stopped = new Promise<null>(resolve => { onAbort = () => resolve(null); signal.addEventListener('abort', onAbort, { once: true }); });
    // O resultado abandonado não é usado e não deve virar "unhandled rejection".
    work.catch(() => undefined);
    return Promise.race([work, stopped]).finally(() => signal.removeEventListener('abort', onAbort));
  }

  /** Encerramento: fecha confirmações abertas e libera esperas de diálogos. */
  cancelAll(): void { this.shutdown.abort(); this.shutdown = new AbortController(); }
}

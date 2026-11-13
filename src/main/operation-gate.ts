/**
 * Porta única de concorrência do processo principal (E4). Substitui as flags globais `busy`,
 * `maintenanceActive`, `sessionTransitionActive`, `shutdownRequested`/`shutdownReady`, o conjunto
 * `activeCompletions` e o antigo `ApplicationOperations`.
 *
 * - Exclusiva: no máximo uma por vez (consulta, manutenção, troca de sessão, etapa CPI). `holder` registra quem
 *   a detém, para regras como "logout só pode aguardar trabalho CPI em segundo plano".
 * - Compartilhada: leituras e consultas por GET; rodam junto com a exclusiva e são drenadas no encerramento.
 * - Segundo plano (`background`): recuperações de consultas pendentes, drenadas antes de trocar a sessão,
 *   limpar dados ou encerrar.
 * - Chave (`key`): impede reentrada de uma mesma ação não exclusiva (ex.: diálogo de pasta).
 * Toda aquisição é liberada em `finally`: sucesso, erro ou cancelamento.
 */
export interface GateOptions {
  exclusive?: boolean;
  /** Quem detém a exclusiva (nome fixo do canal ou do agente). */
  holder?: string;
  /** Rastreia como recuperação em segundo plano (drenada por `drainBackground`). */
  background?: boolean;
  /** Recusa uma segunda execução simultânea com a mesma chave. */
  key?: string;
  /** Mensagem quando a chave já está em uso. */
  busyMessage?: string;
}
export type ShutdownPhase = 'open' | 'closing' | 'blocked' | 'ready';

export const GATE_BUSY_MESSAGE = 'Outra operação está em andamento. Conclua a operação atual.';
const CLOSING_MESSAGE = 'Aplicativo em encerramento; novas operações estão bloqueadas.';

export class OperationGate {
  private readonly active = new Set<Promise<void>>();
  private readonly backgroundWork = new Set<Promise<void>>();
  private readonly keys = new Set<string>();
  private holderName: string | null = null;
  private reservation = false;
  private exclusiveCompletion: Promise<void> | null = null;
  private accepting = true;
  private phase: ShutdownPhase = 'open';

  // ---------- aceitação e encerramento ----------
  assertAccepting(): void { if (!this.accepting) throw new Error(CLOSING_MESSAGE); }
  stopAccepting(): void { this.accepting = false; }
  resumeAccepting(): void { this.accepting = true; }
  /** Inicia o encerramento uma única vez; `false` se já estiver em curso ou concluído. */
  requestShutdown(): boolean {
    if (this.phase === 'closing' || this.phase === 'ready') return false;
    this.phase = 'closing';
    this.accepting = false;
    return true;
  }
  /** Encerramento adiado: antes de fechar o banco volta a aceitar; depois, mantém tudo bloqueado. */
  shutdownFailed(databaseCloseStarted: boolean): void {
    this.phase = databaseCloseStarted ? 'blocked' : 'open';
    if (!databaseCloseStarted) this.accepting = true;
  }
  markShutdownReady(): void { this.phase = 'ready'; }
  isShutdownReady(): boolean { return this.phase === 'ready'; }
  /** Encerramento em curso (novos agendamentos e retomadas não devem começar). */
  isShuttingDown(): boolean { return this.phase === 'closing'; }

  // ---------- exclusividade ----------
  isExclusive(): boolean { return this.holderName !== null || this.reservation; }
  /** Verdadeiro se a exclusiva estiver com um destes donos. */
  heldBy(...holders: string[]): boolean { return this.holderName !== null && holders.includes(this.holderName); }

  async run<T>(work: () => Promise<T>, options: boolean | GateOptions = false): Promise<T> {
    const opts: GateOptions = typeof options === 'boolean' ? { exclusive: options } : options;
    this.assertAccepting();
    if (opts.exclusive && this.isExclusive()) throw new Error(GATE_BUSY_MESSAGE);
    if (opts.key && this.keys.has(opts.key)) throw new Error(opts.busyMessage ?? GATE_BUSY_MESSAGE);
    // Aquisição síncrona: nenhum `await` entre a conferência e a reserva.
    if (opts.exclusive) this.holderName = opts.holder ?? 'exclusive';
    if (opts.key) this.keys.add(opts.key);
    let finish!: () => void;
    const completion = new Promise<void>(resolve => { finish = resolve; });
    if (opts.exclusive) this.exclusiveCompletion = completion;
    this.active.add(completion);
    if (opts.background) this.backgroundWork.add(completion);
    try { return await work(); }
    finally {
      if (opts.exclusive) { this.holderName = null; this.exclusiveCompletion = null; }
      if (opts.key) this.keys.delete(opts.key);
      this.active.delete(completion);
      this.backgroundWork.delete(completion);
      finish();
    }
  }

  /** Reserva a próxima exclusiva antes de esperar a operação CPI em curso terminar (cpi:close, logout). */
  async runExclusiveAfter<T>(prepare: () => Promise<unknown>, work: () => Promise<T>, holder = 'exclusive'): Promise<T> {
    this.assertAccepting();
    if (this.reservation) throw new Error(GATE_BUSY_MESSAGE);
    this.reservation = true;
    try {
      await prepare();
      await this.exclusiveCompletion;
      this.reservation = false;
      return await this.run(work, { exclusive: true, holder });
    } finally { this.reservation = false; }
  }

  // ---------- drenagem ----------
  /** Aguarda as recuperações em segundo plano já aceitas (falhas não interrompem a espera). */
  async drainBackground(): Promise<void> { await Promise.allSettled([...this.backgroundWork]); }
  async waitForIdle(additional: Promise<unknown>[] = [], timeoutMs = 60_000): Promise<boolean> {
    return settleWithin(Promise.allSettled([...this.active, ...additional]), timeoutMs);
  }
}

/** O timeout não cancela trabalhos nem autoriza fechar seus recursos. */
export async function settleWithin(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs)); })
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

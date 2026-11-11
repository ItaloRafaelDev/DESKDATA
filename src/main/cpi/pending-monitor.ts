import type { CpiPendingFilterResult } from './pending-filter.ts';
import { CPI_MIN_INTERVAL_SECONDS, CPI_MAX_INTERVAL_SECONDS } from '../../shared/cpi-monitor-time.ts';
export { CPI_MIN_INTERVAL_SECONDS, CPI_MAX_INTERVAL_SECONDS } from '../../shared/cpi-monitor-time.ts';

/** Resultados limitados ao total da pesquisa 29. Esta fase não lê CPFs nem altera registros. */
export interface CpiMonitorSnapshot {
  phase: 'stopped' | 'checking' | 'waiting' | 'paused' | 'needs_mapping' | 'error';
  intervalSeconds: number;
  checks: number;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  lastTotal: number | null;
  lastResult: CpiPendingFilterResult['state'] | null;
  message: string | null;
}

const DEFAULT_INTERVAL_SECONDS = 60;

export function validateCpiMonitorInterval(intervalSeconds: number): number {
  if (!Number.isSafeInteger(intervalSeconds) ||
    intervalSeconds < CPI_MIN_INTERVAL_SECONDS || intervalSeconds > CPI_MAX_INTERVAL_SECONDS) {
    throw new Error(`Intervalo CPI inválido: utilize um número inteiro entre ${CPI_MIN_INTERVAL_SECONDS} e ${CPI_MAX_INTERVAL_SECONDS} segundos.`);
  }
  return intervalSeconds;
}

/**
 * Agenda uma verificação somente depois da anterior terminar. Nunca há pesquisas concorrentes.
 * Ao encontrar registros, pausa para mapear o DOM das linhas reais antes de ler CPFs.
 * Erros ou rodapé não confirmado pausam o monitor; não são tratados como lista vazia.
 */
export class CpiPendingMonitor {
  private snapshotValue: CpiMonitorSnapshot = {
    phase: 'stopped', intervalSeconds: DEFAULT_INTERVAL_SECONDS, checks: 0,
    lastCheckedAt: null, nextCheckAt: null, lastTotal: null, lastResult: null, message: null
  };
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private generation = 0;
  private readonly poll: () => Promise<CpiPendingFilterResult>;
  private readonly notify: (snapshot: CpiMonitorSnapshot) => void;
  private readonly now: () => Date;

  constructor(
    poll: () => Promise<CpiPendingFilterResult>,
    notify: (snapshot: CpiMonitorSnapshot) => void = () => {},
    now: () => Date = () => new Date()
  ) { this.poll = poll; this.notify = notify; this.now = now; }

  status(): CpiMonitorSnapshot { return { ...this.snapshotValue }; }
  isActive(): boolean { return this.running || this.inFlight !== null; }

  private publish(change: Partial<CpiMonitorSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...change };
    try { this.notify(this.status()); } catch { /* A interface pode ser encerrada entre eventos. */ }
  }

  start(intervalSeconds = DEFAULT_INTERVAL_SECONDS): CpiMonitorSnapshot {
    validateCpiMonitorInterval(intervalSeconds);
    if (this.running || this.inFlight) throw new Error('Já existe uma verificação CPI em andamento.');
    this.generation++;
    this.running = true;
    this.publish({
      phase: 'checking', intervalSeconds, checks: 0, lastTotal: null,
      lastResult: null, lastCheckedAt: null, nextCheckAt: null, message: null
    });
    this.schedule(0, this.generation);
    return this.status();
  }

  /** Pausa novas execuções. Uma verificação já iniciada pode terminar em segurança. */
  pause(): CpiMonitorSnapshot {
    this.running = false;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.publish({phase: 'paused', nextCheckAt: null, message: 'Monitoramento pausado.'});
    return this.status();
  }

  async stopAndWait(): Promise<void> {
    this.running = false;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.publish({phase: 'stopped', nextCheckAt: null, message: null});
    await this.inFlight;
  }

  private schedule(delayMs: number, generation: number): void {
    if (!this.running || generation !== this.generation) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.running || generation !== this.generation) return;
      const pending = this.check(generation);
      this.inFlight = pending;
      void pending.finally(() => { if (this.inFlight === pending) this.inFlight = null; });
    }, delayMs);
  }

  private async check(generation: number): Promise<void> {
    if (!this.running || generation !== this.generation) return;
    this.publish({phase: 'checking', nextCheckAt: null, message: null});
    try {
      const result = await this.poll();
      if (!this.running || generation !== this.generation) return;
      const checks = this.snapshotValue.checks + 1;
      const lastCheckedAt = this.now().toISOString();
      if (result.typeId !== '29' || result.state === 'unconfirmed' || result.total === null ||
        !Number.isSafeInteger(result.total) || result.total < 0 ||
        (result.state === 'empty' && result.total !== 0) ||
        (result.state === 'found' && result.total === 0)) {
        this.running = false;
        this.publish({phase: 'error', checks, lastCheckedAt, nextCheckAt: null,
          lastTotal: null, lastResult: 'unconfirmed', message: 'A CPI não confirmou a listagem. Verifique sessão e filtros.'});
        return;
      }
      if (result.state === 'found') {
        this.running = false;
        this.publish({phase: 'needs_mapping', checks, lastCheckedAt, nextCheckAt: null,
          lastTotal: result.total, lastResult: 'found',
          message: 'Foram encontradas pesquisas. A leitura das linhas requer mapeamento do DOM real antes do processamento.'});
        return;
      }
      const nextCheckAt = new Date(this.now().getTime() + this.snapshotValue.intervalSeconds * 1000).toISOString();
      this.publish({phase: 'waiting', checks, lastCheckedAt, nextCheckAt,
        lastTotal: 0, lastResult: 'empty', message: 'Nenhuma pesquisa pendente. Próxima verificação agendada.'});
      this.schedule(this.snapshotValue.intervalSeconds * 1000, generation);
    } catch {
      if (!this.running || generation !== this.generation) return;
      this.running = false;
      this.publish({phase: 'error', checks: this.snapshotValue.checks + 1,
        lastCheckedAt: this.now().toISOString(), lastTotal: null, lastResult: null, nextCheckAt: null,
        message: 'Falha na leitura da CPI. Confira a sessão e o navegador antes de reiniciar.'});
    }
  }
}

import type { IpcMainInvokeEvent } from 'electron';
import { CPI_STOPPING_INVOKE, DEV_ONLY_INVOKE, EXCLUSIVE_INVOKE, IPC_INVOKE, type ArgsOf, type InvokeMethod, type ResultOf } from '../../shared/ipc-contract.ts';
import { GATE_BUSY_MESSAGE, type OperationGate } from '../operation-gate.ts';
import { toError } from './context.ts';

/** Donos da exclusiva que não são canais: o agente FULL AUTO e o monitor de contagem. */
export const CPI_AUTO_HOLDER = 'cpi:auto';
export const CPI_MONITOR_HOLDER = 'cpi:monitor';

export type Bind = <M extends InvokeMethod>(method: M, handler: (...args: ArgsOf<M>) => Promise<ResultOf<M>>) => void;
interface BinderDeps {
  handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>) => void;
  guard: (event: IpcMainInvokeEvent) => void;
  gate: OperationGate;
  cpiActive: () => { auto: boolean; monitor: boolean };
  pauseCpi: () => Promise<unknown>;
  write: (event: string, fields: Record<string, unknown>) => Promise<void> | undefined;
  /** `!app.isPackaged`: canais de inspeção da CPI só existem fora do instalador. */
  isDev: boolean;
}

/**
 * Registro de canais do contrato: origem verificada (`guard`), OperationGate (exclusiva com dono = canal) e
 * diagnóstico sanitizado (só canal, duração e tipo do erro).
 */
export function createBinder(deps: BinderDeps): Bind {
  return (method, handler) => {
    if (DEV_ONLY_INVOKE.has(method) && !deps.isDev) return;
    const channel = IPC_INVOKE[method];
    const stoppingCpi = CPI_STOPPING_INVOKE.has(method);
    deps.handle(channel, async (event, ...args) => {
      deps.guard(event);
      const began = performance.now();
      try {
        if (stoppingCpi) {
          deps.gate.assertAccepting();
          const active = deps.cpiActive();
          // Só trabalho CPI em segundo plano (agente ou monitor) pode ser aguardado; qualquer outra exclusiva recusa.
          if (deps.gate.isExclusive() && !deps.gate.heldBy(CPI_AUTO_HOLDER, CPI_MONITOR_HOLDER) && !active.auto && !active.monitor)
            throw new Error(method === 'logout' ? 'Conclua a operação atual antes de encerrar a sessão.' : GATE_BUSY_MESSAGE);
        }
        // Entradas são validadas por cada handler; o tipo do contrato é só a forma esperada.
        const work = () => handler(...(args as ArgsOf<typeof method>));
        // A pausa do agente e do monitor acontece só aqui (C10), antes de reservar a exclusiva.
        const result = stoppingCpi
          ? await deps.gate.runExclusiveAfter(deps.pauseCpi, work, channel)
          : await deps.gate.run(work, { exclusive: EXCLUSIVE_INVOKE.has(method), holder: channel });
        void deps.write('ipc_success', { channel, durationMs: performance.now() - began })?.catch(() => {});
        return result;
      } catch (error) {
        void deps.write('ipc_error', { channel, durationMs: performance.now() - began, errorType: toError(error).name })?.catch(() => {});
        throw error;
      }
    });
  };
}

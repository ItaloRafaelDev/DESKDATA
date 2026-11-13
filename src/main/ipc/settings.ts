import { IPC_INVOKE } from '../../shared/ipc-contract.ts';
import type { Bind } from './bind.ts';
import { account, viewSettings, type MainContext } from './context.ts';

/** Pasta de PDFs e autorização de consultas pagas por conta. */
export function registerSettingsIpc(bind: Bind, ctx: MainContext): void {
  const { gate } = ctx;
  bind('getSettings', () => viewSettings(ctx));
  // Fora do bloqueio exclusivo (W25): a espera humana não impede o FULL AUTO nem o encerramento.
  bind('chooseFolder', async () => {
    const who = account(ctx);
    await gate.run(async () => {
      const chosen = await ctx.dialogs.untilShutdown(ctx.pickOutputFolder());
      gate.assertAccepting();
      if (account(ctx) !== who) throw new Error('A sessão mudou durante a seleção de pasta. Nada foi alterado.');
      if (chosen) await ctx.saveOutputFolder(chosen);
    }, { key: IPC_INVOKE.chooseFolder, busyMessage: 'A seleção de pasta já está aberta.' });
    return viewSettings(ctx);
  });
  bind('setPaidQueriesApproved', async approved => {
    const who = account(ctx);
    if (typeof approved !== 'boolean') throw new Error('Valor inválido.');
    await ctx.approvals.setApproved(who, approved);
    return viewSettings(ctx);
  });
}

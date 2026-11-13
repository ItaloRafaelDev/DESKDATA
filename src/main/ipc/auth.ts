import type { Bind } from './bind.ts';
import type { MainContext } from './context.ts';
import { resumeAfterAuthentication } from './recovery.ts';

/** Sessão Deskdata e credenciais protegidas pelo DPAPI. Login e logout são exclusivas do gate (holder = canal). */
export function registerAuthIpc(bind: Bind, ctx: MainContext): void {
  const { client, credentials, monitor, gate, session } = ctx;
  bind('credentialsStatus', () => credentials.status());
  bind('loadSavedCredentials', () => credentials.load());
  bind('forgetSavedCredentials', () => credentials.clear());
  bind('authenticate', async (username, password, remember) => {
    if (typeof username !== 'string' || typeof password !== 'string' || typeof remember !== 'boolean') throw new Error('Credenciais inválidas.');
    if (session.account) throw new Error('Encerre a sessão atual antes de autenticar outra conta.');
    // Holder do login no gate: `account()` informa "troca de sessão" até o fim.
    try {
      monitor.stopAll();
      await gate.drainBackground();
      await client.authenticate(username, password);
      session.account = username.trim().toLowerCase();
      await resumeAfterAuthentication(ctx, session.account);
      if (!remember) return { remembered: false };
      try { await credentials.save(username, password); return { remembered: true }; }
      catch { return { remembered: false, warning: 'A autenticação foi concluída, mas as credenciais não puderam ser salvas com segurança neste computador.' }; }
    } catch (error) {
      // Se o histórico não puder ser recuperado após /auth, não deixar sessão parcialmente iniciada.
      monitor.stopAll(); client.reset(); session.account = null;
      throw error;
    }
  });
  // Holder do logout; o agente e o monitor já foram pausados pelo bind antes da reserva (C10).
  bind('logout', async () => {
    monitor.stopAll();
    await gate.drainBackground();
    await ctx.cpiBrowser.close();
    client.reset(); session.account = null; session.lastCompanyResponse = null; session.lastSavedPdf = null; session.lastPisResponse = null;
    ctx.personReports.clear();
  });
  bind('credits', () => client.credits());
}

import { join } from 'node:path';
import type { MaintenanceResult } from '../../shared/types.ts';
import type { Bind } from './bind.ts';
import { account, type MainContext } from './context.ts';
import { resumeAfterAuthentication } from './recovery.ts';

/** Limpeza local, backups e pasta de diagnóstico. */
export function registerMaintenanceIpc(bind: Bind, ctx: MainContext): void {
  const { gate, maintenance, monitor, cpiAuto, cpiMonitor, session } = ctx;
  bind('maintenancePreview', async () => { account(ctx); return maintenance.preview(); });
  bind('createBackup', async () => {
    account(ctx);
    if (cpiAuto.isActive()) throw new Error('Pause a automação CPI antes de criar o backup.');
    const result = await ctx.backups.create();
    void ctx.diagnostics.write('backup_created', { state: 'success' }).catch(() => {}); return result;
  });
  bind('openDiagnosticsFolder', async () => {
    account(ctx);
    const result = await ctx.openPath(join(ctx.dataDir, 'logs'));
    if (result) throw new Error('Não foi possível abrir a pasta de diagnósticos.');
  });
  bind('openBackupFolder', async () => {
    account(ctx);
    const result = await ctx.openPath(ctx.backups.directory);
    if (result) throw new Error('Não foi possível abrir a pasta de backups.');
  });
  bind('cleanLocalData', async (selection): Promise<MaintenanceResult> => {
    account(ctx);
    if (cpiAuto.isActive() || cpiMonitor.isActive()) throw new Error('Pause a automação CPI antes de executar a limpeza.');
    if (!selection || typeof selection.pdfs !== 'boolean' || typeof selection.history !== 'boolean' || (!selection.pdfs && !selection.history)) throw new Error('Selecione os dados a limpar.');
    // Holder da limpeza no gate: recuperações em segundo plano são ignoradas até o fim (`completePending`).
    monitor.stopAll();
    try {
      // Concluir recuperações aceitas antes de apresentar o resumo ou excluir arquivos.
      await gate.drainBackground();
      const summary = await maintenance.preview();
      const explanation = [
        selection.pdfs ? `${summary.pdfCount} PDF(s) cadastrados no histórico desta instalação serão removidos, quando existentes.` : 'Os PDFs permanecerão no disco.',
        selection.history ? `${summary.recordCount} registro(s) locais de todas as contas serão apagados, incluindo códigos de recuperação.` : 'Os códigos de consulta e o histórico serão mantidos.',
        summary.pendingCount ? `Existem ${summary.pendingCount} consulta(s) pendentes ou incertas no histórico.` : '',
        'A exclusão não remove consultas da Deskdata e não pode ser desfeita pelo aplicativo.'
      ].filter(Boolean).join('\n\n');
      // W24: sem resposta em 120 s ou com o aplicativo encerrando, o diálogo fecha e vale "Cancelar".
      const confirmed = await ctx.dialogs.confirm(signal => ctx.showMessageBox({
        type: 'warning', title: 'Confirmar limpeza local', message: 'Deseja excluir os dados selecionados?', detail: explanation,
        buttons: ['Cancelar', 'Excluir definitivamente'], defaultId: 0, cancelId: 0, noLink: true, signal
      }), 1);
      gate.assertAccepting();
      account(ctx);
      if (cpiAuto.isActive() || cpiMonitor.isActive()) throw new Error('Pause a automação CPI antes de executar a limpeza.');
      if (!confirmed) return { cancelled: true, deletedPdfs: 0, missingPdfs: 0, deletedRecords: 0 };
      const result = await maintenance.clean(selection);
      ctx.personReports.clear(); session.lastSavedPdf = null;
      session.lastCompanyResponse = null; session.lastPisResponse = null;
      return { ...result, cancelled: false };
    } finally {
      if (!gate.isShuttingDown() && session.account) await resumeAfterAuthentication(ctx, session.account);
    }
  });
}

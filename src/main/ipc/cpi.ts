import { isValidCpf } from '../../shared/cpf.ts';
import { assertRecoveredCpf } from '../../shared/query-identity.ts';
import { normalizeDeskdataResponse } from '../../shared/normalizer.ts';
import type { CpiPendingWorkflowStage, CpiWorkflowVerificationResult } from '../../shared/types.ts';
import { inspectCpiPersonHistory } from '../cpi/person-history.ts';
import { prepareCpiPersonPdf } from '../cpi/person-recovery.ts';
import { validateCpiRowId } from '../cpi/pending-rows.ts';
import { reconcileCpiWorkflow } from '../cpi/workflow-reconciliation.ts';
import { findCpiPersonPdf } from '../cpi/person-pdf.ts';
import { saveCpiPdf } from '../cpi/full-auto-orchestrator.ts';
import { buildCpiHistoryOverview } from '../cpi/history-overview.ts';
import type { Bind } from './bind.ts';
import { account, validateStoredPdf, type MainContext } from './context.ts';
import { pending } from './recovery.ts';

/**
 * Canais da CPI. Os de inspeção manual (`DEV_ONLY_INVOKE`) só são registrados pelo binder fora do aplicativo
 * instalado; `cpiClose` e `logout` pausam o agente e o monitor no binder antes da exclusiva (C10).
 */
export function registerCpiIpc(bind: Bind, ctx: MainContext): void {
  const { gate, history, cpiWorkflow, cpiBrowser, cpiAuto, cpiMonitor } = ctx;
  const busyCpi = () => cpiMonitor.isActive() || cpiAuto.isActive();
  bind('cpiHistory', async () => {
    const who = account(ctx);
    return buildCpiHistoryOverview(who, await cpiWorkflow.list(who), history);
  });
  bind('cpiPendingWorkflows', async (page, pageSize) => {
    const who = account(ctx);
    const result = await cpiWorkflow.listPending(who, page, pageSize);
    return { ...result, items: result.items.map(item => {
      const last = item.verificationEvents?.at(-1);
      return { pesquisaId: item.pesquisaId, solicitacaoId: item.solicitacaoId,
        stage: item.stage as CpiPendingWorkflowStage, reviewReason: item.reviewReason,
        lastVerificationReason: last?.reason, createdAt: item.createdAt, submittedAt: item.submittedAt,
        updatedAt: item.updatedAt, lastCheckedAt: last?.at };
    }) };
  });
  bind('cpiVerifyWorkflow', async ids => {
    const who = account(ctx);
    if (!validateCpiRowId(ids)) throw new Error('Identificadores CPI inválidos.');
    if (busyCpi()) throw new Error('Pause o agente e o monitor CPI antes de verificar uma pesquisa.');
    const result = await reconcileCpiWorkflow({ store: cpiWorkflow, account: who, ids,
      checkLocal: async job => {
        if (!job.historyRecordId) return { ready: false };
        const record = await history.findById(who, job.historyRecordId);
        if (!record || record.account !== who || (record.kind !== undefined && record.kind !== 'person') || record.status !== 'ready' || !isValidCpf(record.cpf)) return { ready: false };
        const folder = (await ctx.getSettings()).outputFolder;
        if (!folder) return { ready: false };
        try { await findCpiPersonPdf(record, record.cpf, folder, ids); return { ready: true, cpf: record.cpf }; }
        catch { return { ready: false }; }
      },
      inspectRemote: (target, classification, cpf) => cpiBrowser.inspectPersistedPersonResponse(target, classification, cpf)
    });
    if (ctx.session.account !== who) throw new Error('Conta alterada durante a verificação CPI.');
    const last = result.verificationEvents?.at(-1);
    if (!last) throw new Error('Auditoria da verificação CPI indisponível.');
    // Mesmo retorno de antes da E5; o cast só torna explícito o formato que o contrato tipado já declarava.
    return { stage: result.stage as CpiWorkflowVerificationResult['stage'], reason: last.reason, checkedAt: last.at };
  });
  bind('cpiOpenHistoryPdf', async ids => {
    const who = account(ctx);
    if (!validateCpiRowId(ids)) throw new Error('Identificador de solicitação inválido.');
    const job = await cpiWorkflow.get(who, ids);
    if (job?.stage !== 'completed' || !job.historyRecordId) throw new Error('Pesquisa não concluída ou sem relatório vinculado.');
    const record = await history.findById(who, job.historyRecordId);
    if (!record || (record.kind !== undefined && record.kind !== 'person') || record.account !== who) throw new Error('Relatório não pertence à conta autenticada.');
    for (const path of record.pdfPaths) {
      if (await validateStoredPdf(path)) {
        const error = await ctx.openPath(path);
        if (error) throw new Error('Não foi possível abrir o PDF no leitor padrão.');
        return;
      }
    }
    throw new Error('PDF vinculado indisponível ou inválido.');
  });
  bind('cpiAutoStatus', async () => { account(ctx); return cpiAuto.status(); });
  bind('cpiAutoStart', async seconds => {
    account(ctx);
    if (cpiMonitor.isActive() || gate.isExclusive()) throw new Error('Pause o monitor e conclua a operação atual antes de iniciar FULL AUTO.');
    if (cpiBrowser.status().state !== 'open') throw new Error('Autentique-se na CPI pelo Edge antes de iniciar.');
    if (!await ctx.approvals.isApproved(account(ctx))) throw new Error('Autorize consultas Deskdata para a conta em Minha conta.');
    gate.assertAccepting();
    account(ctx);
    if (cpiMonitor.isActive() || gate.isExclusive()) throw new Error('Conclua a operação atual antes de iniciar FULL AUTO.');
    ctx.cpiQueue.reset();
    return cpiAuto.start(seconds);
  });
  bind('cpiAutoPause', async () => { account(ctx); return cpiAuto.pause(); });
  bind('cpiOpen', async () => { account(ctx); return cpiBrowser.open(); });
  bind('cpiStatus', async () => { account(ctx); return cpiBrowser.status(); });
  bind('cpiInspect', async () => { account(ctx); if (busyCpi()) throw new Error('Pause o monitor antes de inspecionar o DOM.'); return cpiBrowser.inspectControls(); });
  bind('cpiFilterPerson29', async () => { account(ctx); if (busyCpi()) throw new Error('Pause o monitor antes de aplicar o filtro manualmente.'); return cpiBrowser.filterPendingPerson29(); });
  bind('cpiInspectPendingRows', async () => { account(ctx); if (busyCpi()) throw new Error('Pause o monitor antes de inspecionar as linhas.'); return cpiBrowser.inspectPendingRows(); });
  bind('cpiInspectPendingPersonDetails', async ids => {
    account(ctx);
    if (busyCpi()) throw new Error('Pause o monitor antes de abrir os detalhes.');
    if (!validateCpiRowId(ids)) throw new Error('Identificadores CPI inválidos.');
    return cpiBrowser.inspectPendingPersonDetails(ids);
  });
  bind('cpiInspectPersonHistory', async ids => {
    const accountId = account(ctx);
    if (busyCpi()) throw new Error('Pause o monitoramento e conclua as operações atuais.');
    if (!validateCpiRowId(ids)) throw new Error('Identificadores CPI inválidos.');
    // Revalida o detalhe ativo antes de usar o CPF somente no processo principal.
    await cpiBrowser.inspectPendingPersonDetails(ids);
    const cpf = cpiBrowser.readValidatedCpf(ids);
    const { outputFolder } = await ctx.getSettings();
    const result = await inspectCpiPersonHistory({
      account: accountId, cpf, pesquisaId: ids.pesquisaId, solicitacaoId: ids.solicitacaoId,
      outputFolder, findLatest: (currentAccount, currentCpf, kind) => history.findLatest(currentAccount, currentCpf, kind)
    });
    if (ctx.session.account !== accountId) throw new Error('Sessão alterada durante a leitura do histórico.');
    return result;
  });
  bind('cpiPreparePersonPdf', async ids => {
    const accountId = account(ctx);
    if (busyCpi()) throw new Error('Pause o monitoramento e conclua as operacoes atuais.');
    if (!validateCpiRowId(ids)) throw new Error('Identificadores CPI invalidos.');
    // A exclusiva do gate abrange leitura de CPF, historico e GET opcional.
    await cpiBrowser.inspectPendingPersonDetails(ids);
    const cpf = cpiBrowser.readValidatedCpf(ids);
    const { outputFolder } = await ctx.getSettings();
    const prepared = await prepareCpiPersonPdf({
      ids, account: accountId, cpf, outputFolder,
      findLatest: (who, document, kind) => history.findLatest(who, document, kind),
      regenerateCpiPdf: async record => {
        // Somente GET do codigo ja registrado; nenhum POST. O PDF regerado recebe o nome CPI desta pesquisa.
        const code = record.queryCode;
        if (!code || !outputFolder) throw new Error('Consulta sem codigo recuperavel ou pasta ausente; nenhum POST sera enviado.');
        if (ctx.monitor.isWatching(record.id)) return { state: 'pending' };
        const received = await ctx.client.checkByCode(code);
        if (received.state === 'pending') { await pending(ctx, record); return { state: 'pending' }; }
        assertRecoveredCpf(received.payload, cpf);
        await saveCpiPdf(ctx, accountId, ids, outputFolder, cpf, record.id, code, normalizeDeskdataResponse(received.payload));
        return { state: 'ready' };
      }
    });
    if (ctx.session.account !== accountId) throw new Error('Sessao Deskdata alterada durante a preparacao.');
    return prepared;
  });
  bind('cpiMonitorStart', async intervalSeconds => {
    account(ctx);
    if (gate.isExclusive()) throw new Error('Conclua a operação atual antes de iniciar o monitor.');
    if (cpiAuto.isActive()) throw new Error('Pause o ciclo FULL AUTO primeiro.');
    if (cpiBrowser.status().state !== 'open') throw new Error('Abra o Edge e autentique na CPI antes de iniciar o monitor.');
    return cpiMonitor.start(intervalSeconds);
  });
  bind('cpiMonitorPause', async () => { account(ctx); return cpiMonitor.pause(); });
  bind('cpiMonitorStatus', async () => { account(ctx); return cpiMonitor.status(); });
  // O agente e o monitor já foram pausados pelo bind antes da reserva (C10).
  bind('cpiClose', async () => { account(ctx); await cpiBrowser.close(); });
}

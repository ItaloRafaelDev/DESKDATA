import { cnpjDigits, isValidCnpj } from '../../shared/cnpj.ts';
import type { QueryExecution } from '../../shared/types.ts';
import type { StepTimer } from '../step-timing.ts';
import type { Bind } from './bind.ts';
import { account, assertPaidQueryApproved, timedCycle, validateStoredPdf, type MainContext } from './context.ts';
import { exportCompany, pending, ready, resolveRecorded } from './recovery.ts';

/** Consulta empresarial (CNPJ). Registro cifrado antes do POST; recuperação só por código. */
export function registerCompanyIpc(bind: Bind, ctx: MainContext): void {
  bind('queryCompanyAndSave', rawCnpj => timedCycle(ctx, 'company', timer => queryCompanyAndSaveTimed(ctx, rawCnpj, timer), result => result.state));
  bind('companyHistory', async () => (await ctx.history.list(account(ctx), 'company')).map(({ account: _account, ...record }) => record));
  bind('regenerateCompany', async recordId => {
    const record = await ctx.history.findById(account(ctx), recordId);
    if (!record || record.kind !== 'company' || !record.cnpj) throw new Error('Consulta empresarial não encontrada.');
    if (!record.queryCode) throw new Error('A consulta não possui código recuperável.');
    return resolveRecorded(ctx, record);
  });
}

async function queryCompanyAndSaveTimed(ctx: MainContext, rawCnpj: string, timer: StepTimer): Promise<QueryExecution> {
  const { history, client } = ctx;
  if (ctx.cpiAuto.isActive()) throw new Error('Pause o ciclo CPI FULL AUTO antes de consultar manualmente.');
  if (typeof rawCnpj !== 'string' || !isValidCnpj(rawCnpj)) throw new Error('CNPJ inválido.');
  const cnpj = cnpjDigits(rawCnpj);
  const settings = await ctx.getSettings();
  if (!settings.outputFolder) throw new Error('Configure a pasta de destino antes de consultar.');
  const who = account(ctx);
  const previous = await history.findLatestCompany(who, cnpj);
  if (previous) {
    for (const path of [...previous.pdfPaths].reverse()) {
      if (await validateStoredPdf(path)) return ready({ path, recordId: previous.id, queryCode: previous.queryCode, savedAt: previous.updatedAt, reused: true });
    }
    const cachedCompany = ctx.session.lastCompanyResponse;
    if (cachedCompany?.cnpj === cnpj) return ready({ ...await timer.step('report_pdf', () => exportCompany(ctx, cnpj, cachedCompany.payload, previous.id, cachedCompany.queryCode)), reused: true });
    if (!previous.queryCode) throw new Error('Consulta anterior sem PDF nem código recuperável. Não será enviado outro POST automaticamente.');
    return resolveRecorded(ctx, previous, timer);
  }
  await assertPaidQueryApproved(ctx);
  if (await timer.step('deskdata_credits', () => client.credits()) <= 0) throw new Error('Saldo de créditos indisponível.');
  const record = await history.beginCompany(who, cnpj); // persistir antes do POST
  const result = await timer.step('deskdata_query', () => client.submitCompany(cnpj, code => history.setCode(record.id, code)));
  if (result.state === 'pending') return pending(ctx, { ...record, queryCode: result.queryCode });
  return ready(await timer.step('report_pdf', () => exportCompany(ctx, cnpj, result.payload, record.id, result.queryCode)));
}

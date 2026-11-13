import { open, realpath, stat } from 'node:fs/promises';
import { basename, relative, isAbsolute, sep } from 'node:path';
import { cpfDigits, isValidCpf } from '../../shared/cpf.ts';
import type { QueryRecord } from '../query-history.ts';
import { cpiPdfPattern } from '../pdf-names.ts';
import { validateCpiRowId, type CpiPendingRowId } from './pending-rows.ts';
import { isDeadlineError, withDeadline } from '../deadline.ts';
import { PDF_FILE_TIMEOUT_MS } from '../pdf-render.ts';

/**
 * Único PDF aceito para anexar na CPI. Exige todas as condições:
 * nome CPI_<pesquisaId>_<solicitacaoId>_<data> do item em processamento; caminho registrado na consulta
 * vinculada; arquivo dentro da pasta configurada (caminho canônico); assinatura %PDF-.
 * PDFs legados (nome com CPF) nunca são aceitos. Nunca varre a pasta nem escolhe PDF de outra consulta.
 */
export interface PersonPdfFileSystem { realpath: typeof realpath; stat: typeof stat; open: typeof open }
const NODE_FS: PersonPdfFileSystem = { realpath, stat, open };

/** Leitura com prazo (E3/W6): a pasta pode estar numa unidade de rede que não responde. Só lê; nada é repetido. */
export async function findCpiPersonPdf(record: QueryRecord | null, cpf: string, configuredFolder: string, ids: CpiPendingRowId,
  timeoutMs = PDF_FILE_TIMEOUT_MS, fs: PersonPdfFileSystem = NODE_FS): Promise<string> {
  try { return await withDeadline(locate(record, cpf, configuredFolder, ids, fs), timeoutMs, 'pdf_check'); }
  catch (error) {
    if (!isDeadlineError(error)) throw error;
    throw new Error('A pasta de PDFs não respondeu a tempo. Nenhum anexo será enviado.', { cause: error });
  }
}

async function locate(record: QueryRecord | null, cpf: string, configuredFolder: string, ids: CpiPendingRowId, fs: PersonPdfFileSystem): Promise<string> {
  const { realpath, stat, open } = fs;
  if (!isValidCpf(cpf)) throw new Error('CPF da solicitação CPI inválido.');
  if (!validateCpiRowId(ids)) throw new Error('Identificadores CPI inválidos para validar o PDF.');
  const document = cpfDigits(cpf);
  if (!record || (record.kind !== undefined && record.kind !== 'person') ||
      record.cpf !== document || record.status !== 'ready') {
    throw new Error('Consulta de pessoa correspondente não está pronta no histórico.');
  }
  if (!configuredFolder || !isAbsolute(configuredFolder)) throw new Error('Pasta de PDFs não configurada.');
  const root = await realpath(configuredFolder);
  if (!(await stat(root)).isDirectory()) throw new Error('Pasta de PDFs inválida.');
  const namePattern = cpiPdfPattern(ids);
  // A primeira referência válida é a mais recente registrada na consulta específica.
  for (const path of [...record.pdfPaths].reverse()) {
    if (!isAbsolute(path) || !namePattern.test(basename(path))) continue;
    let canonical: string;
    try { canonical = await realpath(path); } catch { continue; }
    const rel = relative(root, canonical);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    const info = await stat(canonical).catch(() => null);
    if (!info?.isFile() || info.size < 100) continue;
    const fd = await open(canonical, 'r');
    try {
      const signature = Buffer.alloc(5);
      const { bytesRead } = await fd.read(signature, 0, 5, 0);
      if (bytesRead === 5 && signature.equals(Buffer.from('%PDF-'))) return canonical;
    } finally { await fd.close(); }
  }
  throw new Error('PDF correspondente não encontrado ou inválido na pasta configurada. Nenhum anexo será enviado.');
}

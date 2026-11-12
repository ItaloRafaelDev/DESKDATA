import { open, realpath, stat } from 'node:fs/promises';
import { basename, relative, isAbsolute, sep } from 'node:path';
import { cpfDigits, isValidCpf } from '../../shared/cpf.ts';
import type { QueryRecord } from '../query-history.ts';

/** Nunca varre a pasta por nome ou escolhe o PDF mais recente de outra consulta. */
export async function findCpiPersonPdf(record: QueryRecord | null, cpf: string, configuredFolder: string): Promise<string> {
  if (!isValidCpf(cpf)) throw new Error('CPF da solicitação CPI inválido.');
  const document = cpfDigits(cpf);
  if (!record || (record.kind !== undefined && record.kind !== 'person') ||
      record.cpf !== document || record.status !== 'ready') {
    throw new Error('Consulta de pessoa correspondente não está pronta no histórico.');
  }
  if (!configuredFolder || !isAbsolute(configuredFolder)) throw new Error('Pasta de PDFs não configurada.');
  const root = await realpath(configuredFolder);
  if (!(await stat(root)).isDirectory()) throw new Error('Pasta de PDFs inválida.');
  const namePattern = new RegExp(`^RELATORIO_${document}_\\d{4}-\\d{2}-\\d{2}(?:-\\d{2})?\\.pdf$`, 'i');
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

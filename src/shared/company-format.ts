import { formatDatePtBr, translateEnum } from './localization.ts';

type JsonObject = Record<string, unknown>;
function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}
function has(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}
function first(source: JsonObject, keys: readonly string[]): unknown {
  for (const key of keys) if (has(source[key])) return source[key];
  return undefined;
}
const captions: Record<string, string> = {
  code: 'Código', description: 'Descrição', legal_class: 'Classificação jurídica',
  number: 'Número', registration: 'Registro', status: 'Situação',
  state: 'UF', uf: 'UF', date: 'Data', type: 'Tipo',
  value: 'Valor', name: 'Nome', full_name: 'Nome',
  legal_name: 'Razão social', state_registration: 'Inscrição estadual'
};

/** Valor textual de apresentação: jamais converte objetos diretamente com String(obj). */
export function formatCompanyValue(value: unknown, preferredKeys: readonly string[] = []): string {
  const visited = new WeakSet<object>();
  const visit = (entry: unknown, level: number, preferred: readonly string[] = []): string => {
    if (!has(entry)) return '';
    if (typeof entry === 'string') return entry.trim();
    if (typeof entry === 'number') return Number.isFinite(entry) ? String(entry) : '';
    if (typeof entry === 'boolean') return entry ? 'Sim' : 'Não';
    if (entry === null || typeof entry !== 'object' || level > 8 || visited.has(entry)) return '';
    visited.add(entry);
    if (Array.isArray(entry)) {
      const result = entry.map(v => visit(v, level + 1)).filter(Boolean).join(' | ');
      visited.delete(entry);
      return result;
    }
    const data = asObject(entry)!;
    if (preferred.length) {
      const picked = first(data, preferred);
      if (has(picked)) {
        const result = visit(picked, level + 1);
        if (result) { visited.delete(entry); return result; }
      }
    }
    const code = first(data, ['code', 'id']);
    const description = first(data, ['description', 'label', 'title']);
    if (has(code) && has(description)) {
      const result = `${visit(code, level + 1)} — ${visit(description, level + 1)}`;
      visited.delete(entry);
      return result;
    }
    const number = first(data, ['number', 'registration_number', 'registration']);
    const state = first(data, ['state', 'uf']);
    if (has(number)) {
      const result = [has(state) ? visit(state, level + 1) : '', visit(number, level + 1)].filter(Boolean).join(' — ');
      visited.delete(entry);
      return result;
    }
    if (has(code) && has(data.date)) {
      const result = `${translateEnum(code)} — ${formatDatePtBr(data.date)}`;
      visited.delete(entry);
      return result;
    }
    const common = first(data, ['full_name', 'legal_name', 'corporate_name', 'company_name', 'trade_name', 'name', 'value']);
    if (has(common)) {
      const result = visit(common, level + 1);
      if (result) { visited.delete(entry); return result; }
    }
    if (has(description)) {
      const result = visit(description, level + 1);
      if (result) { visited.delete(entry); return result; }
    }
    const parts = Object.entries(data).map(([key, item]) => {
      const rendered = visit(item, level + 1);
      if (!rendered) return '';
      return `${captions[key] ?? (/^[A-Z]{2}$/.test(key) ? key : key.replace(/_/g, ' '))}: ${rendered}`;
    }).filter(Boolean);
    visited.delete(entry);
    return parts.join(' | ');
  };
  return visit(value, 0, preferredKeys);
}

/** Atividade econômica com código e descrição, sem perder formatos simples ou estruturados. */
export function formatCompanyActivity(value: unknown): string {
  const data = asObject(value);
  if (!data) return formatCompanyValue(value);
  const code = formatCompanyValue(first(data, ['code', 'cnae', 'cnae_code', 'activity_code']));
  const description = formatCompanyValue(first(data, ['description', 'name', 'activity_name', 'label', 'value']));
  return [code, description].filter(Boolean).join(' — ') || formatCompanyValue(value);
}

/** Aceita lista, objeto unitário e listas sob items; não inventa atividades ausentes. */
export function companyActivityList(value: unknown): unknown[] {
  if (!has(value)) return [];
  if (Array.isArray(value)) return value;
  const data = asObject(value);
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Object.keys(data).length === 0) return [];
  return [value];
}

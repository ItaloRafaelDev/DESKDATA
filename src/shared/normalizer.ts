import { DATASETS, type DatasetName, type NormalizedData } from './types.ts';

function object(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export class DataContractError extends Error {
  constructor(message: string) { super(message); this.name = 'DataContractError'; }
}

export function normalizeDeskdataResponse(payload: unknown): NormalizedData {
  const envelope = object(payload);
  const status = object(envelope?.status);
  if (!envelope || Number(status?.code) !== 4000) {
    throw new DataContractError('Consulta sem confirmação de sucesso (status.code 4000).');
  }
  const data = object(envelope.data);
  if (!data) throw new DataContractError('Resposta não contém o objeto data.');
  const output = {} as NormalizedData;
  for (const dataset of DATASETS) {
    if (!Object.prototype.hasOwnProperty.call(data, dataset)) {
      throw new DataContractError(`Dataset ${dataset} ausente na resposta.`);
    }
    const value = data[dataset];
    if (value === null || value === undefined) {
      throw new DataContractError(`Dataset ${dataset} retornou valor nulo.`);
    }
    const datasetObj = object(value);
    const datasetStatus = object(datasetObj?.status);
    const datasetError = datasetObj?.error;
    if (datasetError || (datasetStatus && 'code' in datasetStatus && ![4000, 2000].includes(Number(datasetStatus.code)))) {
      throw new DataContractError(`Dataset ${dataset} sinalizou erro específico.`);
    }
    if (!datasetObj) throw new DataContractError(`Dataset ${dataset} não retornou objeto válido.`);
    let normalizedValue: Record<string, unknown> = datasetObj;
    if (dataset !== 'basic') {
      const hasItems = Object.prototype.hasOwnProperty.call(datasetObj, 'items');
      if (!hasItems && datasetObj.total === 0) {
        // Inferência conservadora: zero registros comprovado pelo contador.
        // Não assumir lista vazia sem indicação explícita do serviço.
        normalizedValue = { ...datasetObj, items: [] };
      } else if (!hasItems) {
        throw new DataContractError(`Dataset ${dataset}: campo items ausente; não é possível confirmar uma lista completa. Resposta mantida em memória para reprocessamento sem nova consulta.`);
      } else if (!Array.isArray(datasetObj.items)) {
        throw new DataContractError(`Dataset ${dataset}: campo items inválido (esperada uma matriz). Resposta mantida em memória para diagnóstico.`);
      }
    }
    const items = normalizedValue.items;
    const isEmpty = dataset === 'basic'
      ? Object.keys(datasetObj).filter(k => k !== 'status').length === 0
      : (items as unknown[]).length === 0;
    output[dataset as DatasetName] = { status: isEmpty ? 'empty' : 'ok', value: normalizedValue };
  }
  return output;
}

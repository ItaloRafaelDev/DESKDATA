/** Resposta sensível mantida somente em RAM até o aplicativo ser encerrado ou a sessão terminar. */
export interface ReceivedQuery {
  cpf: string;
  consultedAt: string;
  queryCode?: string;
  payload: unknown;
}

export class QueryRecovery<T extends ReceivedQuery = ReceivedQuery> {
  private value: T | null = null;
  remember(result: T): void { this.value = result; }
  exists(): boolean { return this.value !== null; }
  matches(cpf: string): boolean { return this.value?.cpf === cpf; }
  read(): T | null { return this.value; }
  clear(): void { this.value = null; }
}

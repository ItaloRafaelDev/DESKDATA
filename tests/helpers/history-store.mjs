import { QueryHistoryStore } from '../../src/main/query-history.ts';

/** Registra todas as conexões abertas pelo teste; nunca apaga arquivos sem fechá-las. */
export function historyTestScope() {
  const stores = [];
  return {
    open(directory, protector) {
      const store = new QueryHistoryStore(directory, protector);
      stores.push(store);
      return store;
    },
    async closeAll() {
      const results = await Promise.allSettled(stores.map(store => store.close()));
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    }
  };
}

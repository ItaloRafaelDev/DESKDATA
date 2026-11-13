# DESKDATA v0.1.13 — Correção EBUSY do SQLite no Windows

## Sintoma

`npm test` na v0.1.12 apresenta `EBUSY: resource busy or locked, unlink ...\queries.sqlite` em testes que apagam diretórios temporários. Não é erro de resposta da API Deskdata. O histórico real do usuário não deve ser apagado para tentar corrigir o erro.

## Causa confirmada

`src/main/query-history.ts` mantém um `DatabaseSync` aberto, sem API de encerramento. Os testes executam `rm(...,{recursive:true,force:true})` enquanto há handles de conexões SQLite. Isso pode funcionar em sistemas com semântica POSIX de unlink, mas falha no Windows, que bloqueia a exclusão do arquivo aberto.

## Correção

1. `QueryHistoryStore.close()` agora é idempotente, aguarda a fila de operações já aceitas, fecha o SQLite e impede o uso após encerramento. Operações de leitura também participam da mesma fila, evitando fechamento enquanto são processadas.
2. Os testes usam `tests/helpers/history-store.mjs` para rastrear e fechar todas as conexões antes de remover as pastas. Testes de exclusão do banco ou da chave encerram explicitamente a conexão primeiro.
3. `src/main/index.ts` trata `before-quit`: interrompe o monitor GET, aguarda conclusões em curso e chama `history.close()` antes de permitir que o Electron encerre.
4. Foram adicionados testes de ciclo de vida e de integração da rotina de encerramento.

Nenhuma migração extra, alteração de schema, remoção de `queries.bin`, exclusão de PDF ou chamada à Deskdata está incluída nesta correção.

## Verificações no ambiente de preparação

- `npm test`: **92 testes aprovados de 92** com Node v22.16.0 em Linux, zero falhas.
- `node --experimental-strip-types --check src/main/query-history.ts`: aprovado.
- `node --experimental-strip-types --check src/main/index.ts`: aprovado.
- `npm run typecheck`: não executável integralmente nesta máquina por faltar as definições `node` e `vite/client`; precisa ser repetido no Windows com `npm install` concluído.
- `npm run build` e execução visual do Electron: pendentes no Windows.
- Nenhuma consulta real Deskdata foi realizada; não houve consumo de créditos.

## Homologação obrigatória no Windows

1. Feche Electron e pare o servidor com `Ctrl+C`.
2. Faça backup do projeto e dos arquivos de histórico cifrado em `%APPDATA%\deskdata-desktop` antes de substituir fontes.
3. Aplique o ZIP incremental em `I:\DEV`, preservando a estrutura `DESKDATA/...`.
4. Execute `node -v`, `npm test`, `npm run typecheck` e `npm run build`.
5. Repita `npm test` para verificar ausência de erro intermitente; confirme **92 testes sem falhas**.
6. Inicie o Electron, verifique históricos das três consultas e o botão de backup, sem emitir consultas pagas.
7. Encerre/reabra o aplicativo para confirmar liberação do arquivo SQLite.

**Se o erro persistir:** envie o primeiro stack trace completo, a versão de Node e uma relação de processos ainda em execução (`Get-Process node,electron -ErrorAction SilentlyContinue`). Não apagar o banco, suas chaves ou a marca de migração para contornar o bloqueio.

## Observações

O evento `before-quit` não é garantido no encerramento forçado do processo ou no desligamento do Windows; transações SQLite continuam responsáveis pela integridade nesses cenários. A correção reduz vazamentos de handles durante o encerramento normal e elimina a condição identificada nos testes, mas requer homologação no Windows.

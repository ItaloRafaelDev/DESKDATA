# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [Não lançado]

### Adicionado
- CI no GitHub Actions (`windows-latest`): `npm ci`, typecheck, testes e build; lint e `npm audit` informativos.
- ESLint (flat config, typescript-eslint, regras de hooks do React) e Prettier, sem formatação aplicada ao código.
- `AGENTS.md` com regras invariantes do projeto, `.editorconfig` e `.nvmrc` (Node 22).

### Removido
- Arquivos do pnpm (`pnpm-lock.yaml`, `pnpm-workspace.yaml`); o projeto usa somente npm.
- Pacote `npm` listado indevidamente como dependência de runtime.

### Inalterado
- Nenhuma alteração em `src/` ou `tests/`; comportamento do aplicativo preservado.

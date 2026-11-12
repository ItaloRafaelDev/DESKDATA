# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [Não lançado]

### Adicionado
- CI no GitHub Actions (`windows-latest`): `npm ci`, typecheck, testes e build; lint e `npm audit` informativos.
- ESLint (flat config, typescript-eslint, regras de hooks do React) e Prettier, sem formatação aplicada ao código.
- `AGENTS.md` com regras invariantes do projeto, `.editorconfig` e `.nvmrc` (Node 24).
- CSP restritiva no documento de impressão dos PDFs (pessoa, PIS, CNPJ): só estilos inline e imagens `data:`, sem scripts nem rede.

### Corrigido
- Testes CPI comparavam caminhos temporários não canônicos; falhavam no runner Windows (TEMP com nome 8.3).
- Erros de lint (causa preservada em erros relançados, imports e variáveis sem uso).
- Geração de PDF podia travar indefinidamente; agora tem timeout total de 120 s (carregamento, fontes e `printToPDF`), destrói a janela de impressão e não grava arquivo parcial.

### Removido
- Arquivos do pnpm (`pnpm-lock.yaml`, `pnpm-workspace.yaml`); o projeto usa somente npm.
- Pacote `npm` listado indevidamente como dependência de runtime.
- Artefatos locais versionados por engano (CLAUDE.md, lote.diff, testes-removidos.txt).

### Inalterado
- Comportamento do aplicativo preservado.

# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [Não lançado]

### Adicionado
- CI no GitHub Actions (`windows-latest`): `npm ci`, typecheck, testes e build; lint e `npm audit` informativos.
- ESLint (flat config, typescript-eslint, regras de hooks do React) e Prettier, sem formatação aplicada ao código.
- `AGENTS.md` com regras invariantes do projeto, `.editorconfig` e `.nvmrc` (Node 24).
- CSP restritiva no documento de impressão dos PDFs (pessoa, PIS, CNPJ): só estilos inline e imagens `data:`, sem scripts nem rede.
- Teste `no-personal-data`: falha se algum arquivo versionado contiver CPF válido fora da allowlist de CPFs fictícios (relata arquivo, linha e CPF mascarado).
- Medição de duração por etapa no ciclo CPI (filtro, linhas, seleção, abrir detalhe, ler CPF, consulta, PDF, preencher, anexar, salvar, fechar) e nas consultas manuais de pessoa, PIS e CNPJ, gravada no diagnóstico com um id de correlação por ciclo e sem dados pessoais (`step-timing.ts`).
- Inventário de gargalos e riscos de travamento da v0.2 em `docs/diagnostico/2026-11-gargalos.md`.

### Alterado
- `CLAUDE.md` passa a importar só o `AGENTS.md` (fonte única de regras); as regras úteis que faltavam foram movidas para o `AGENTS.md`.

### Corrigido
- Testes CPI comparavam caminhos temporários não canônicos; falhavam no runner Windows (TEMP com nome 8.3).
- Erros de lint (causa preservada em erros relançados, imports e variáveis sem uso).
- Geração de PDF podia travar indefinidamente; agora tem timeout total de 120 s (carregamento, fontes e `printToPDF`), destrói a janela de impressão e não grava arquivo parcial.
- Limpeza parcial de PDFs expunha na mensagem de erro o caminho do arquivo (que contém o CPF); agora a mensagem é genérica e mantém a contagem de PDFs excluídos.
- Marcadores de conflito de merge que tinham ficado neste CHANGELOG.

### Removido
- Arquivos do pnpm (`pnpm-lock.yaml`, `pnpm-workspace.yaml`); o projeto usa somente npm.
- Pacote `npm` listado indevidamente como dependência de runtime.
- Artefatos locais versionados por engano (CLAUDE.md, lote.diff, testes-removidos.txt).

### Inalterado
- Comportamento do aplicativo preservado.

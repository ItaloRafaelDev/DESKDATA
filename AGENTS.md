# AGENTS.md — DESKDATA

Instruções para qualquer pessoa ou agente de IA que altere este repositório.

## Projeto

Aplicativo desktop Electron + React + TypeScript para consultas na API Deskdata (pessoa, PIS, CNPJ),
geração de relatórios PDF e automação de respostas no portal CPI Central (Edge via `playwright-core`).

- `src/main/` — processo principal: API, sessão, histórico cifrado (SQLite), PDF, automação CPI.
- `src/preload/` — ponte IPC (`contextBridge`). Única superfície exposta ao renderer.
- `src/renderer/` — interface React. Não acessa rede, disco nem segredos diretamente.
- `src/shared/` — validações, normalização e modelos de relatório (código puro, testável).
- `tests/` — Node test runner (`node --test`). Nenhum teste chama serviços reais.

## Comandos

```powershell
npm ci             # instalar a partir do lockfile
npm run typecheck
npm test
npm run build
npm run lint
npm run dev        # aplicativo em desenvolvimento
```

Gerenciador de pacotes: **somente npm**. Não adicionar `pnpm-lock.yaml` ou `yarn.lock`.

## Regras invariantes (não negociáveis)

1. **Nunca repetir um POST `/queries` com resultado incerto** (timeout, falha de rede, ausência de `query_code`).
   Consultas existentes são recuperadas apenas por `GET /queries/{query_code}`. O registro é persistido antes do POST.
2. **Nenhum teste, script ou validação automatizada faz chamada real** à Deskdata ou à CPI, nem consome créditos.
3. **CPF, CNPJ, nomes, senhas, tokens, cookies e conteúdo de consultas nunca vão para logs**, mensagens de erro
   expostas, commits, fixtures ou documentação. Fixtures usam apenas dados fictícios (ex.: `000.000.000-00`).
4. **Uma operação por vez**: respeitar os bloqueios de concorrência e de transição de sessão existentes.
5. **Automação CPI**: resultado ambíguo de envio vira revisão manual; nunca reenviar anexo ou resposta automaticamente.
   Clicar em salvar não é prova de persistência.
6. **Electron**: manter `sandbox`, `contextIsolation`, `nodeIntegration: false`, guard de origem do IPC,
   bloqueio de navegação e de novas janelas. Toda entrada IPC é validada no processo principal.
7. Não excluir nem sobrescrever dados do usuário (`%APPDATA%\deskdata-desktop`, PDFs, histórico) sem autorização.

## Fluxo de trabalho

- Mudanças pequenas em branch própria (`feature/…`, `fix/…`, `chore/…`) com PR; a CI precisa estar verde.
- Não fazer commit, push, merge, release, force push ou reescrita de histórico sem pedido explícito.
- Não misturar formatação em massa com mudança de comportamento no mesmo commit.
- Corrigir causa raiz; bug corrigido ganha teste de regressão quando viável. Não alterar asserções para esconder defeito.
- Build aprovado não comprova o fluxo: declarar exatamente o que foi testado e o que depende de validação no Windows
  com Electron, Edge, conta Deskdata e sessão CPI reais.
- Registrar mudanças relevantes em `CHANGELOG.md`.

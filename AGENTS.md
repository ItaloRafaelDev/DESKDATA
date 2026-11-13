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

Todo texto exibido ao usuário, mensagens de erro e documentação ficam em **português do Brasil**.

### Arquitetura (pontos que não aparecem só lendo um arquivo)

- **IPC:** todo canal é registrado por `bind()` em `src/main/index.ts`, que aplica `guard()` (só o frame principal
  da janela principal), passa pelo `OperationGate` (`operation-gate.ts`) e grava diagnóstico sanitizado.
  O gate é a única fonte de estado de concorrência: exclusiva com dono (`holder` = canal), segundo plano drenável,
  chave contra reentrada e fases do encerramento. Não crie flags globais (`busy` e similares). Canal novo usa `bind()`;
  se altera estado compartilhado, entra em `exclusiveChannels`. `cpi:close` e `auth:logout` pausam o FULL AUTO e param
  o monitor no `bind()` antes de reservar a exclusiva.
- **Preload** expõe o `DesktopApi` tipado (`src/shared/types.ts`) e é gerado como CJS (`index.cjs`).
- **CPI** (`src/main/cpi`): `cpi-browser.ts` controla o Edge (`playwright-core`, login manual).
  `full-cycle.ts` (`executeCpiPersonCycle`) executa um item: reivindicar → consulta Deskdata → classificar
  (`person-rules.ts`) → PDF → anexar e salvar → confirmar (`response-confirmation.ts`). O progresso fica cifrado em
  `workflow-store.ts`, com os estágios `claimed → query_started → query_pending → pdf_ready → submit_started → completed`,
  ou `verification_required` / `review_required`. Leia o documento correspondente em `docs/` antes de alterar a CPI.
  O FULL AUTO (`full-auto-runner.ts`) roda enquanto houver pesquisas: `queue-selection.ts` nunca reabre itens finais
  ou em revisão; `failure-classes.ts` decide entre parada imediata (D1) e revisão do item (3 seguidas da mesma classe pausam).
- **Prazos e cancelamento** (`deadline.ts`): toda espera externa tem prazo. As operações do `CpiBrowser` rodam em
  `bounded()` (`CPI_OPERATION_TIMEOUTS`) e conferem o sinal (`throwIfAborted`) antes de cada efeito; `close()`
  cancela. `DeskdataClient.reset()` aborta requisições e polling. Prazo estourado após efeito possível nunca repete.
- **Criptografia:** `credentials.ts` abstrai o `safeStorage` (DPAPI) em `CredentialProtector`; os stores são testados
  com um protetor falso.
- **Diagnóstico de tempo:** `step-timing.ts` mede etapas com um `correlationId` por ciclo; só nomes fixos de etapa
  chegam ao log (`diagnostics.ts` filtra por lista fechada).

## Comandos

```powershell
npm ci             # instalar a partir do lockfile
npm run typecheck  # o build não faz typecheck; rode separadamente
npm test
npm run build
npm run lint
npm run dev        # aplicativo em desenvolvimento
node --experimental-strip-types --test tests/<arquivo>.test.mjs   # um arquivo (use --test-name-pattern "<nome>")
npm run test:demo  # também test:demo:pis e test:demo:cnpj: HTML de exemplo com dados fictícios, sem rede
```

Gerenciador de pacotes: **somente npm**. Não adicionar `pnpm-lock.yaml` ou `yarn.lock`. Node 24 (`.nvmrc`).
Instalador: `.\scripts\build-windows.ps1` (`dist:win`), que exige certificado de assinatura (`forceCodeSigning: true`).

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
8. **Consultas pagas:** HTTP 202 reaproveita o `query_code` existente (polling, sem novo POST). Nova consulta exige
   autorização por conta (`account-approval.ts`) e conferência de saldo (`cpi/paid-balance.ts`).
9. **Persistência:** nunca gravar em disco respostas brutas da API, senhas ou tokens. A fila CPI não guarda CPF,
   documento nem conteúdo de PDF.
10. **Relatórios:** o HTML escapa todo conteúdo vindo da API. Dataset ausente ou com falha bloqueia o PDF, em vez de
    gerar um relatório com aparência completa. A esfera "Criminal" é só um indicador (em vermelho), não juízo de culpa.
11. **Troca de sessão ou de conta** interrompe o trabalho CPI em curso (conferências `sessionAccount !== who`).

## Convenções de código e testes

- Testes são `.mjs` que importam os `.ts` diretamente (type stripping do Node). O TypeScript precisa ser apagável:
  sem `enum`, `namespace` ou parameter properties no construtor; imports relativos mantêm a extensão `.ts`.
- `tests/helpers/main-process.mjs` (`withMainProcess`) carrega o `src/main/index.ts` real numa VM com `electron`
  simulado; `tests/helpers/cpi-portal.mjs` simula o portal CPI; `history-store.mjs` cria stores temporários.
- CPFs de teste: apenas os fictícios da allowlist de `tests/no-personal-data.test.mjs` (ex.: `52998224725`).
- Estilo denso (funções compactas, pouco espaço em branco): siga o arquivo ao redor.
- Commits no padrão convencional com escopo, ex.: `fix(cpi): ...`.

## Fluxo de trabalho

- Mudanças pequenas em branch própria (`feature/…`, `fix/…`, `chore/…`) com PR; a CI precisa estar verde.
- Não fazer commit, push, merge, release, force push ou reescrita de histórico sem pedido explícito.
- Não misturar formatação em massa com mudança de comportamento no mesmo commit.
- Corrigir causa raiz; bug corrigido ganha teste de regressão quando viável. Não alterar asserções para esconder defeito.
- Build aprovado não comprova o fluxo: declarar exatamente o que foi testado e o que depende de validação no Windows
  com Electron, Edge, conta Deskdata e sessão CPI reais.
- Registrar mudanças relevantes em `CHANGELOG.md`.

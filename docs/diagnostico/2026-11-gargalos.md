# Diagnóstico de gargalos e base de medição — v0.2 (Etapa 0)

Data: 2026-11-12 · Branch: `feature/v02-e0-diagnostico` · Base: `main` em `844ec9a`.

Este documento é a entrega da Etapa 0 do plano `docs/superpowers/plans/2026-11-12-plano-v0.2-cpi-estabilidade.md`.
Cada item recebe um ID, a localização (arquivo:linha na branch desta etapa), a classe de risco
(**travamento**, **loop** ou **desempenho**), a severidade e a etapa que o trata (E1 a E5).
Itens que não serão tratados ficam marcados como **aceito (baixo)**, com justificativa.

Legenda de severidade: **alta** = pode parar o FULL AUTO ou o app sem saída; **média** = pode atrasar
muito ou exigir intervenção; **baixa** = efeito limitado ou improvável.

Observação sobre o Playwright: o código não chama `setDefaultTimeout`. Ações de locator sem `timeout`
explícito (`click`, `getAttribute`, `isChecked`, `textContent`, `locator.evaluate`) usam o padrão de 30 s
**para localizar o elemento**. `frame.evaluate`, `locator.evaluateAll`, `elementHandle.contentFrame`,
`browser.newContext`, `context.newPage`, `page.bringToFront` e `browser.close` não têm limite de tempo próprio:
se o script da página ou o Edge parar de responder, a espera não termina.

---

## 1. Esperas externas

| ID | Local | Espera | Limite atual | Risco | Sev. | Etapa |
|---|---|---|---|---|---|---|
| W1 | `src/main/deskdata-client.ts:43-67` | `fetch` da Deskdata (inclui leitura do corpo) | 35 s via `AbortController`; sem `AbortSignal` externo | travamento | baixa | **resolvido** (E3): `reset()` aborta a requisição; prazo extra para transporte que ignora o sinal. `e3-timeouts` — "E3/W1: …" (3 testes) |
| W2 | `src/main/deskdata-client.ts:90-98` | `awaitResult`: 24 × (sleep 5 s + GET até 35 s) | pior caso ≈ 16 min; `sleep` não é cancelável | travamento | **alta** | **resolvido** (E3): prazo total de 180 s (máx. 24 tentativas), espera cancelável por `reset()`. `e3-timeouts` — "E3/W2/W3: polling por código respeita o prazo total…", `e3-timeouts` — "E3/W2: logout durante a espera do polling…" |
| W3 | `src/main/index.ts:136` (`fetchByCode` no ciclo CPI), `:386`, `:394`, `:414` | `fetchByCode` → W2 dentro de operação exclusiva, com o modal CPI aberto no caso do ciclo | herda W2 | travamento | **alta** | **resolvido** (E3): herda W1/W2; o ciclo CPI já usa só `checkByCode` (E2). `e3-timeouts` — "E3/W2/W3: polling por código respeita o prazo total…" |
| W4 | `src/main/index.ts:403` | `queryBasicCpf` (PIS) → `queryWithKey` → W2 dentro do IPC | herda W2 | travamento | média | **resolvido** (E3): herda W1/W2. `e3-timeouts` — "E3/W4: consulta PIS (POST + polling) sem resposta no GET…" |
| W5 | `src/main/pdf-render.ts:43-59` | carregar HTML, fontes e `printToPDF` | 120 s total, janela destruída (#12) | travamento | — | **resolvido** (PR #12) |
| W6 | `src/main/pdf-render.ts:26-34`, `src/main/cpi/person-pdf.ts:15-32` | `stat`/`writeFile`/`realpath`/`open` na pasta do usuário (pode ser unidade de rede) | nenhum; a escrita do PDF fica fora do timeout de 120 s | travamento | média | **resolvido** (E3): prazo de 30 s na gravação (`pdf_write`) e na conferência para anexo (`pdf_check`); caminho não é registrado no estouro. `e3-timeouts` — "E3/W6: …" (2 testes) |
| W7 | `src/main/cpi/cpi-browser.ts:53` | `chromium.launch` | 25 s | travamento | — | aceito (baixo): já limitado |
| W8 | `src/main/cpi/cpi-browser.ts:55-56` | `browser.newContext`, `context.newPage` | nenhum | travamento | baixa | **resolvido** (E3): abertura inteira em `cpi_open` (75 s); processo criado é fechado se o prazo estourar. `e3-timeouts` — "E3/W8: abertura sem resposta…" |
| W9 | `src/main/cpi/cpi-browser.ts:44` | `page.bringToFront` | nenhum | travamento | baixa | **resolvido** (E3): `cpi_focus` (5 s). `e3-timeouts` — "E3/W9/W10: focar e fechar o navegador…" |
| W10 | `src/main/cpi/cpi-browser.ts:548` (chamado por `index.ts:726`, `:758` e `cpi-browser.ts:48`) | `browser.close()` | nenhum em `cpi:close`, `auth:logout` e reabertura; 60 s só no encerramento (`index.ts:818`) | travamento | média | **resolvido** (E3): `cpi_close` (15 s); referências descartadas antes, falha não propagada. `e3-timeouts` — "E3/W9/W10: focar e fechar o navegador…" |
| W11 | `src/main/cpi/cpi-browser.ts:150-173` | abrir detalhe: `buttons.count()` + `button.evaluate` por botão + polling | laço com prazo de 20 s, mas cada `evaluate`/`frame.evaluate` interno não tem limite | travamento | média | **resolvido** (E3): abrir detalhe e ler CPF em `cpi_open_detail` (45 s), cancelável. `e3-timeouts` — "E3/W11/W12: abrir detalhe sem resposta…" |
| W12 | `src/main/cpi/cpi-browser.ts:206-218` | `readDetailFrame`: `isVisible`, `elementHandle` (500 ms), `contentFrame`, `frame.evaluate` | `frame.evaluate` sem limite | travamento | média | **resolvido** (E3): coberto por `cpi_open_detail`, `cpi_save` e `cpi_reconcile`. `e3-timeouts` — "E3/W11/W12: abrir detalhe sem resposta…" |
| W13 | `src/main/cpi/cpi-browser.ts:364-382` | preencher: `selects.count()`, `element.evaluate`, `selectOption` (10 s) | `evaluate` só com o padrão de 30 s | travamento | baixa | **resolvido** (E3): `cpi_save` (60 s + confirmação); antes do anexo o estouro devolve `not_submitted` e o corpo tardio não age. `e3-timeouts` — "E3/W13: prazo do salvamento antes do anexo…" |
| W14 | `src/main/cpi/cpi-browser.ts:387-413` | marcar resultado: `evaluateAll` em laço com prazo de 12 s | `evaluateAll` sem limite | travamento | média | **resolvido** (E3): coberto por `cpi_save`; sinal conferido a cada iteração. `e3-timeouts` — "E3/W13: prazo do salvamento antes do anexo…" |
| W15 | `src/main/cpi/cpi-browser.ts:417-450` | anexo: `waitFor` (12 s), `getAttribute`, `textContent`, `files.evaluate`, `setInputFiles` | `setInputFiles` e `evaluate` com o padrão de 30 s | travamento | baixa | **resolvido** (E3): coberto por `cpi_save`; a partir do anexo o estouro vira `unverified` (→ `verification_required`), nunca repete. `e3-timeouts` — "E3/W16: espera sem fim depois do clique…" |
| W16 | `src/main/cpi/cpi-browser.ts:505-524` | clique em Alterar e laço de confirmação | prazo de 20 s; `savedResponseEvidence` → `frame.evaluate` sem limite | travamento | média | **resolvido** (E3): estouro ou cancelamento após o clique → `unverified`, sem segundo envio. `e3-timeouts` — "E3/W16: espera sem fim depois do clique…" |
| W17 | `src/main/cpi/cpi-browser.ts:286` | reconciliação: `frame.goto` | 15 s | travamento | — | aceito (baixo): já limitado |
| W18 | `src/main/cpi/cpi-browser.ts:304-315` | fechar Shadowbox: `innerText` (4 s), `getAttribute`, `evaluate`, `waitFor hidden` (7 s) | parcial (padrão 30 s nos demais) | travamento | baixa | **resolvido** (E3): fechar detalhe em `cpi_close_detail` (75 s); estouro → revisão (catch do ciclo), estado não é limpo. `e3-timeouts` — "E3/W18/W19: fechar detalhe sem resposta…" |
| W19 | `src/main/cpi/pending-refresh.ts:39-74` | após salvar: `waitFor` (8 s), busca de "Mostrar Tudo" (8 s), `click` (10 s), leitura estável (20 s) | prazos por laço, mas `inspectPendingPerson29Rows` usa `frame.evaluate` sem limite | travamento | média | **resolvido** (E3): coberto por `cpi_close_detail`; sinal conferido em cada laço. `e3-timeouts` — "E3/W18/W19: fechar detalhe sem resposta…" |
| W20 | `src/main/cpi/pending-filter.ts:29-39`, `:63-81` | `visibleControl` (12 s) e `readListingCount` (25 s) | prazo por laço; `frame.evaluate` interno sem limite | travamento | média | **resolvido** (E3): coberto por `cpi_filter` (150 s); sinal conferido em cada iteração. `e3-timeouts` — "E3/W20/W21: filtro 29 com frame que não responde…" |
| W21 | `src/main/cpi/pending-filter.ts:92-127` | filtro 29: `goto` (30 s), cliques (10–15 s), `getAttribute`/`isChecked` (padrão 30 s), `evaluateAll` | `evaluateAll` sem limite | travamento | baixa | **resolvido** (E3): `cpi_filter`; nenhum clique depois do prazo. `e3-timeouts` — "E3/W20/W21: filtro 29 com frame que não responde…" |
| W22 | `src/main/cpi/pending-rows.ts:63-71` | leitura de linhas: `frame.evaluate` por frame | nenhum | travamento | média | **resolvido** (E3): `cpi_rows` (30 s). `e3-timeouts` — "E3/W22/L8: leitura das linhas…" |
| W23 | `src/main/cpi/cpi-browser.ts:79` | inspeção de controles (diagnóstico manual): `evaluateAll` | nenhum | travamento | baixa | **resolvido** (E3): `cpi_inspect` (20 s); canal de desenvolvimento segue para E5. |
| W24 | `src/main/index.ts:581` | `dialog.showMessageBox` da limpeza, com operação exclusiva, `busy` e `maintenanceActive` presos | espera humana sem limite; o encerramento falha após 60 s com o diálogo aberto | travamento | baixa | **resolvido** (E3): `DialogGuard`: diálogo fecha em 120 s ou no encerramento e vale "Cancelar". `e3-timeouts` — "E3/W24: limpeza com diálogo sem resposta…" |
| W25 | `src/main/settings.ts:22` (via `index.ts:536`) | `dialog.showOpenDialog` dentro de operação exclusiva | espera humana sem limite | travamento | baixa | **resolvido** (E3): fora do bloqueio exclusivo, reentrada bloqueada, resultado descartado no encerramento. `e3-timeouts` — "E3/W25: seleção de pasta não prende…" |
| W26 | `src/main/index.ts:816-820` | encerramento: `waitForIdle` (60 s) e `history.close()` | `history.close` sem limite (aguarda a fila do SQLite) | travamento | baixa | aceito (baixo): só aguarda operações locais já aceitas; preferir esperar a perder escrita |
| W27 | `src/main/credentials.ts`, `query-history.ts:134-137`, `cpi/workflow-store.ts:61-84` | DPAPI assíncrono (`safeStorage.*Async`) | nenhum | travamento | baixa | aceito (baixo): chamada local do Windows, sem rede; um timeout aqui deixaria dados sem saber se foram gravados |
| W28 | `src/main/index.ts:555`, `:560`, `:660`, `:779`, `:789`, `:795` (`shell.openPath`) | abrir PDF/pasta no Windows | nenhum | travamento | baixa | aceito (baixo): ação manual do usuário, fora do FULL AUTO |
| W29 | `src/main/http-response.ts:22-31` | leitura do corpo em partes | coberto pelo `AbortController` de W1 e pelo limite de 8 MB | — | — | aceito (baixo): já limitado |

## 2. Laços, polling e recursão

Todo laço abaixo tem a condição de parada citada. Os itens marcados como risco têm parada que depende de
uma espera sem limite (seção 1) ou que contradiz D1.

| ID | Local | Laço | Condição de parada | Risco | Sev. | Etapa |
|---|---|---|---|---|---|---|
| L1 | `src/main/cpi/full-auto-runner.ts:58-92` | `cycle()` reagendado por `setTimeout` | `shouldRun=false` (pausa, erro ou item em revisão) | loop | — | **resolvido na E2**: `while(!signal.aborted)` (`full-auto-runner.ts:121`), abortado por `pause()` (`:92`) e por parada sistêmica (`:106`); espera cancelável de ≥ 2 s por volta (`:169`) |
| L2 | `src/main/index.ts:112-120` + `full-cycle.ts:43-46` + `full-auto-runner.ts:64-70` | seleção do próximo item | pega o **primeiro item não concluído**, inclusive `review_required`/`verification_required`; o ciclo devolve `review_required` e o runner **pausa**. A cada novo início o mesmo item volta e pausa de novo: a fila fica bloqueada por um único item | loop | **alta** | **resolvido na E2**: `queue-selection.ts` pula `completed`, `review_required`, `verification_required` e `submit_started`; falha de item vai para revisão e o agente segue |
| L3 | `src/main/index.ts:112-120` + `full-cycle.ts:85-87` | item em `query_pending` | volta a ser escolhido a cada ciclo e executa `fetchByCode` (W2, até ≈ 16 min) com o modal aberto | loop / travamento | **alta** | **resolvido na E2** no ciclo CPI: um único `checkByCode` (35 s); se ainda 202, devolve `pending` e o item é adiado em memória (60 s → 10 min). O polling de W2 segue nas consultas manuais (E3) |
| L4 | `src/main/cpi/full-auto-runner.ts:12-15` | atraso entre ciclos | 2 s se houve conclusão e restam itens; senão o intervalo (≥ 30 s). Sem espera crescente com fila vazia | desempenho | baixa | **resolvido na E2**: fila vazia espera 30 s → 60 → 120 → 240 → teto (padrão 300 s); 2 s após item |
| L5 | `src/main/cpi/pending-monitor.ts:91-137` | monitor de contagem CPI | `running`/`generation`; para em erro ou ao encontrar itens | loop | — | aceito (baixo): parada clara; avaliar remoção do monitor legado em E2 |
| L6 | `src/main/pending-queries.ts:50-87` | GET de consultas pendentes | `attempts ≥ 40`, `failures ≥ 3` ou erro permanente; reagenda a cada 2 s enquanto houver 2 GETs em curso (`:53`) | loop | baixa | aceito (baixo): limites explícitos; o reagendamento de 2 s termina quando um GET termina (cada GET tem 35 s) |
| L7 | `src/main/deskdata-client.ts:91` | polling de resultado | 24 tentativas | loop | — | **resolvido** (E3): 24 tentativas + prazo total + cancelamento (W2). |
| L8 | `src/main/cpi/cpi-browser.ts:171`, `:387`, `:513`; `pending-refresh.ts:42`, `:56`; `pending-filter.ts:31`, `:65` | polling do DOM com `Date.now() < deadline` | prazo de 8–25 s, conferido só entre iterações | loop | média | **resolvido** (E3): cada operação tem prazo total e confere o sinal por iteração (W11–W22). |
| L9 | `src/main/pdf-render.ts:28` | nomes `-02`…`-100` | 99 tentativas (`-02` a `-99`) | loop | — | **resolvido na E1** (padrão `-NN`, `PDF_MAX_COPIES_PER_DAY`) |
| L10 | `src/main/http-response.ts:22` | `for(;;)` de leitura | fim do stream, limite de 8 MB ou abort | loop | — | aceito (baixo): parada garantida |
| L11 | `src/main/cpi/pending-filter.ts:111`, `pending-rows.ts:88/128/145`, `cpi-browser.ts:150/364/424` | laços sobre `count()` ou listas do DOM | tamanho finito da coleção | loop | — | aceito (baixo): limitados pelo DOM; o custo por iteração está em W13/W21 |
| L12 | `src/main/index.ts:263-267` | retomada de pendentes no login | lista finita | loop | — | aceito (baixo); custo em P3 |
| L13 | `src/renderer/main.tsx:293-295`, `:306` | `setInterval` de 5 s (`cpi:status`) e relógio de 1 s | limpos no `return` do `useEffect` | loop | — | aceito (baixo): `cpi:status` não acessa a rede nem o disco além do log de IPC |
| L14 | — | recursão | nenhuma recursão síncrona encontrada em `src/main`; a única "recursão" é o reagendamento de L1/L5/L6 | — | — | — |

## 3. Estado de concorrência

| ID | Local | Estado | Observação | Etapa |
|---|---|---|---|---|
| C1 | `src/main/index.ts:62` | `busy` | verificado e alterado manualmente em ~20 handlers; redundante dentro de canais já exclusivos (ex.: `cpiScanOneTimed` `:97`) | **resolvido** (E4): removido; exclusividade só pelo `OperationGate` (as conferências dentro de canais exclusivos eram código morto). `operation-gate-characterization` (10 testes, passam antes e depois sem alteração) |
| C2 | `src/main/index.ts:70` | `maintenanceActive` | só a limpeza; bloqueia `completePending` (`:243`) | **resolvido** (E4): `gate.heldBy('maintenance:clean')`; recuperações ignoradas durante a limpeza e drenadas antes. `operation-gate-e4` — "recuperação em segundo plano é ignorada durante a limpeza…" |
| C3 | `src/main/index.ts:71` | `sessionTransitionActive` | login/logout; `account()` lança durante a troca | **resolvido** (E4): `gate.heldBy('auth:login','auth:logout')`. `operation-gate-characterization` (10 testes, passam antes e depois sem alteração) — "durante a troca de sessão…" |
| C4 | `src/main/index.ts:802-803` | `shutdownRequested`, `shutdownReady` | encerramento; `shutdownRequested` volta a `false` se falhar | **resolvido** (E4): fases do gate (`open → closing → ready`, `blocked` após iniciar o fechamento do banco). `operation-gate-e4` — "fases do encerramento…" |
| C5 | `src/main/operations.ts:2-46` | `ApplicationOperations` (`exclusive`, `reservation`, `closing`, `active`) | exclusão por canal (`exclusiveChannels`, `index.ts:45-51`) e `runExclusiveAfter` para `cpi:close`/`auth:logout` | **resolvido** (E4): `ApplicationOperations` substituído pelo `OperationGate` (mesma API de `run`/`runExclusiveAfter`, mais `holder`, `key`, `background`). `operation-gate`, `operation-gate-e4` |
| C6 | `src/main/index.ts:75` | `activeCompletions` | recuperações de consultas pendentes aguardadas na limpeza, no login/logout e no encerramento | **resolvido** (E4): `run(…, {background:true})` + `gate.drainBackground()`. `operation-gate-e4` — "drenagem aguarda só o segundo plano…" |
| C7 | `src/main/index.ts:525-528` | `PendingQueryMonitor.complete` roda como operação **não exclusiva**: gera PDF e altera `lastSavedPdf` em paralelo a uma operação exclusiva (inclusive um ciclo CPI) | risco de corrida | **resolvido** (E4): recuperação continua concorrente (não trava o FULL AUTO), mas não altera mais o "último PDF" da sessão. `operation-gate-e4` — "E4/C7…" (falha sem a correção) |
| C8 | `src/main/cpi/full-auto-runner.ts:32-34` | `shouldRun`, `current`, `timer` | `pause()` aguarda o ciclo em curso **sem limite** (`:53`) | **resolvido na E2**: `pause()` aborta a espera na hora e aguarda só o item já iniciado, sem abrir outro (o sinal chega à varredura). O ciclo não contém mais o polling de ≈ 16 min; o limite de cada passo do navegador é E3 |
| C9 | `src/main/cpi/pending-monitor.ts:37-40` | `running`, `inFlight`, `generation` | `stopAndWait()` aguarda `inFlight` sem limite (`:88`) | **resolvido** (E3): a leitura do filtro tem prazo (`cpi_filter`) e é cancelada por `cpi:close`; `stopAndWait` termina no prazo. `e3-timeouts` — "E3/C9: parar o monitor com leitura do filtro presa…" |
| C10 | `src/main/index.ts:165-175`, `:726`, `:756-757` | pausa do runner e do monitor feita duas vezes (no `bind` e no handler) em `cpi:close` e `auth:logout` | redundância, sem efeito incorreto | **resolvido** (E4): pausa feita só no `bind()` antes da reserva; removida dos handlers. |
| C11 | `src/main/backup.ts:30`, `maintenance.ts:17`, `cpi/cpi-browser.ts:27` (`opening`) | flags locais (`creating`, `cleaning`, `opening`) | protegem contra reentrada na própria classe | **resolvido** (E4): `creating`/`cleaning` removidos (canais exclusivos no gate). `opening` do `CpiBrowser` mantido: não é flag de concorrência, é o handle da abertura em curso que `close()` aguarda para não deixar o Edge órfão. |
| C12 | `query-history.ts:51-53`, `cpi/workflow-store.ts:56`, `account-approval.ts:13`, `diagnostics.ts:8` | filas internas de serialização (`mutation`, `queue`) | serializam escrita de cada store; não são estado global de operação | aceito (baixo): manter fora do `OperationGate`; são locks de dados, não de fluxo |
| C13 | `src/main/index.ts:537` (`settings:approve`) | `settings:approve` não é exclusivo | alterar a autorização durante um ciclo: o ciclo confere `paidApproved` e o saldo imediatamente antes do POST (`full-cycle.ts:59-63`) | aceito (baixo): a conferência fica no ponto do efeito |

## 4. Bloqueios do processo principal

| ID | Local | Operação | Custo | Risco | Sev. | Etapa |
|---|---|---|---|---|---|---|
| P1 | `src/main/cpi/workflow-store.ts:61-84`, `:109-112` | cada `get`/`claim`/`mark` lê, decifra (DPAPI) e valida o arquivo inteiro (até 10.000 itens); cada `mark` regrava tudo | O(n) por operação | desempenho | média | **resolvido na E2**: cache em memória validado por tamanho e mtime do arquivo; decifra só quando o arquivo muda; cada `mark` ainda regrava o arquivo (atomicidade preservada) |
| P2 | `src/main/index.ts:112-120` | seleção do item: até 100 `cpiWorkflow.get` por varredura, cada um com P1 | O(100 × n) por ciclo | desempenho | média | **resolvido na E2**: `cpiWorkflow.stages()` lê a fila uma vez por varredura |
| P3 | `src/main/query-history.ts:167-174` | `list`/`listAll` decifram todas as linhas; usados no login (`index.ts:263`), na limpeza e no backup | O(histórico) | desempenho | baixa | E5 |
| P4 | `src/main/query-history.ts:238-248` | `removePdfReferences` decifra e recifra todas as linhas | O(histórico) | desempenho | baixa | aceito (baixo): só na limpeza manual |
| P5 | `src/main/query-history.ts:92-101` | `new DatabaseSync` e `PRAGMA integrity_check` síncronos na inicialização | O(tamanho do banco), uma vez | desempenho | baixa | aceito (baixo): só na primeira operação; garante integridade antes de consultas pagas |
| P6 | `src/main/query-history.ts:160-196` | `DatabaseSync` (`prepare`/`get`/`run`) síncrono no processo principal | por consulta, com índice | desempenho | baixa | aceito (baixo): consultas indexadas e pontuais; nenhuma em laço no FULL AUTO |
| P7 | `src/main/backup.ts:10`, `:17` | `crc32` em JS byte a byte e `deflateRawSync` do snapshot inteiro (até 100 MB) | bloqueia a interface durante o backup | desempenho | média | E5 |
| P8 | `src/main/index.ts:600-617` | `cpi:history:list`: decifra a fila inteira, até 100 `findById` e `stat`; chamado a cada mudança de `processed` (`renderer/main.tsx:298-302`) | O(n) por item processado | desempenho | média | **parcial na E2**: a fila CPI vem do cache (P1); os `findById`/`stat` do histórico seguem (E5) |
| P9 | `src/main/diagnostics.ts:23-37` | cada evento faz `mkdir`, `stat`, `appendFile`, `readdir` e `stat` de todos os logs | ~6 operações de disco por evento; a Etapa 0 adiciona ~15 eventos por ciclo | desempenho | baixa | aceito (baixo): fila serial assíncrona, ≤ 6 arquivos; não bloqueia o ciclo (gravação sem `await` no ciclo) |
| P10 | `src/main/index.ts:497` | `mkdirSync` da pasta de dados | uma vez, antes da janela | desempenho | — | aceito (baixo) |
| P11 | `src/main/settings.ts:8-16` | `getSettings` lê `settings.json` a cada chamada | arquivo pequeno | desempenho | — | aceito (baixo) |

## 5. Limites de quantidade residuais (D1)

| ID | Local | Limite | Etapa |
|---|---|---|---|
| Q1 | `src/main/cpi/workflow-store.ts:24-25` | `MAX_WORK_ITEMS=10000`: com 10.000 registros na fila, todo o processamento CPI é bloqueado | **resolvido na E2**: teto removido |
| Q2 | `src/main/cpi/pending-rows.ts:28`, `:117` | no máximo 100 linhas mapeadas por página; páginas seguintes não são lidas | **resolvido na E2** (teto local de 100 removido; vale o que a página exibe, limitado ao total do rodapé). Páginas seguintes da CPI continuam não lidas: itens atendidos saem da página e os seguintes sobem; se todas as linhas visíveis estiverem em revisão, o agente informa e espera (risco registrado para E6) |
| Q3 | `src/main/index.ts:603` | histórico CPI exibe só os 100 concluídos mais recentes | aceito (baixo): limite de exibição, não de processamento |

## 6. Instrumentação adicionada nesta etapa

Módulo novo: `src/main/step-timing.ts` (`createStepTimer`). Cada ciclo recebe um `correlationId` (UUID v4).

- Evento `timing_step`: `flow`, `correlationId`, `step`, `durationMs`, `state` (`success`/`failed`) e,
  em falha, `errorType` (nome da classe do erro).
- Evento `timing_cycle`: `flow`, `correlationId`, `durationMs`, `state` e `outcome`.

| `flow` | Etapas (`step`) | Onde |
|---|---|---|
| `cpi` | `cpi_filter`, `cpi_rows`, `cpi_select` | `index.ts` (`cpiScanOneTimed`) |
| `cpi` | `cpi_open_detail`, `cpi_read_cpf` | `cpi-browser.ts` (`inspectPendingPersonDetails`) |
| `cpi` | `deskdata_credits`, `deskdata_query` ou `deskdata_fetch`, `report_pdf`, `cpi_close_detail` | `full-cycle.ts` |
| `cpi` | `cpi_fill`, `cpi_attach`, `cpi_save` | `cpi-browser.ts` (`uploadAndSavePersonResponse`) |
| `person`, `pis`, `company` | `deskdata_credits`, `deskdata_query`, `deskdata_fetch`, `report_pdf` | `index.ts` (consultas manuais) |

Valores de `outcome`: `completed`, `verification_required`, `review_required`, `pending` (CPI);
`ready`, `pending`, `no_pis` (manuais); `empty` (filtro sem itens) e `idle` (nenhum item elegível na página);
`item_failed` (E2: falha de item enviada para revisão).

Privacidade: o temporizador só recebe nomes fixos; o `DiagnosticLogger` aceita `flow`, `step` e `outcome`
apenas de listas fechadas e `correlationId` apenas no formato UUID. CPF, CNPJ, nomes, caminhos de PDF
e códigos de consulta não entram no evento (testes: `tests/step-timing.test.mjs`,
`tests/person-report-ipc.test.mjs`). Uma falha ao gravar o diagnóstico nunca interrompe o ciclo.

### Como ler a base de medição

Os logs ficam em `%APPDATA%\deskdata-desktop\logs\app-AAAA-MM-DD.jsonl`. Média e máximo por etapa:

```powershell
Get-Content "$env:APPDATA\deskdata-desktop\logs\app-*.jsonl" | ConvertFrom-Json |
  Where-Object event -eq 'timing_step' | Group-Object flow,step |
  ForEach-Object { [pscustomobject]@{ etapa=$_.Name; n=$_.Count;
    media_ms=[int]($_.Group | Measure-Object durationMs -Average).Average;
    max_ms=($_.Group | Measure-Object durationMs -Maximum).Maximum;
    falhas=@($_.Group | Where-Object state -eq 'failed').Count } }
```

Os valores de referência só existem depois de ciclos reais (Etapa 6). Nesta etapa, nenhuma consulta
real foi executada; a medição foi comprovada com fakes nos testes.

## 7. Resumo por etapa

| Etapa | Itens |
|---|---|
| E1 | L9 |
| E2 | L1, L2, L3, L4, C8, C9, P1, P2, P8, Q1, Q2 |
| E3 | W1–W4, W6, W8–W16, W18–W25, L3, L7, L8 |
| E4 | C1–C7, C10, C11 |
| E5 | P3, P7 (e o canal de inspeção de W23) |
| Resolvido | W5 (PR #12), L9 (E1) |
| Aceito (baixo) | W7, W17, W26–W29, L5, L6, L10–L13, C12, C13, P4–P6, P9–P11, Q3 |

Prioridade sugerida pela severidade: L2 e L3 (fila bloqueada por um item e `fetchByCode` longo dentro do
ciclo) e W2/W3 (polling de ≈ 16 min sem cancelamento) são os principais candidatos a "travamento" do FULL AUTO.

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
- Nomes dos PDFs sem CPF nem CNPJ: respostas CPI geram `CPI_<pesquisaId>_<solicitacaoId>_<data>.pdf`; consultas manuais geram `RELATORIO_`, `PIS_` e `CNPJ_<queryCode>_<data>.pdf` (`SEM-CODIGO` quando a API não devolve código). Regerações no mesmo dia recebem sufixo `-02` a `-99`, sem sobrescrever. Arquivos antigos não são renomeados e continuam reconhecidos pela limpeza.
- O anexo da CPI só aceita o PDF `CPI_` do par pesquisa/solicitação em processamento, registrado na consulta vinculada, dentro da pasta configurada e com assinatura `%PDF-`. PDFs legados nunca são enviados: sem PDF no padrão novo, o PDF é regerado a partir do resultado já registrado na Deskdata (GET pelo código), sem novo POST.
- FULL AUTO contínuo: o agente processa uma pesquisa por vez enquanto houver pesquisas pendentes. Com a fila vazia, espera 30 s, 60 s, 120 s... até o teto escolhido (padrão 5 min); o campo da tela passa a ser "Espera máxima com fila vazia".
- Pesquisas concluídas, em revisão, em verificação ou com envio já iniciado nunca são reabertas pelo agente, inclusive após reiniciar o aplicativo. Uma pesquisa com falha vai para revisão manual e o agente segue para a próxima.
- O agente só pausa sozinho por condição sistêmica: sessão CPI ou Deskdata expirada, saldo ou autorização insuficiente, portal não reconhecido, fila protegida indisponível, troca de conta, ou 3 falhas seguidas do mesmo tipo (inclui 3 envios seguidos sem confirmação). A falta de autorização Deskdata agora pausa o agente em vez de devolver "revisão" sem registrar o item.
- Pausar cancela a espera na hora; uma pesquisa já iniciada termina e nenhuma nova é aberta.
- Consulta Deskdata ainda em processamento no ciclo CPI: um único GET por ciclo (sem polling de até 16 min com o detalhe aberto); a pesquisa é retomada depois por GET, sem novo POST.
- A tela do agente mostra a pesquisa atual (somente os códigos CPI), a duração do ciclo e os contadores da sessão (concluídas, em revisão, falhas, ciclos).
- A fila CPI protegida é lida uma vez por varredura e mantida em cache na memória, invalidado quando o arquivo muda.
- A escolha da pasta dos PDFs não bloqueia mais as outras operações enquanto o diálogo está aberto. Se a sessão mudar ou o aplicativo começar a encerrar, nada é gravado.
- Sem resposta em 2 min, a confirmação da limpeza local fecha sozinha e vale "Cancelar". O mesmo acontece ao encerrar o aplicativo.
- Concorrência unificada: uma única porta de operações (`OperationGate`) controla consultas, limpeza, troca de sessão, automação CPI e encerramento, no lugar das marcações espalhadas pelo processo principal. As recusas mantêm as mensagens de antes, e toda operação é liberada ao terminar, falhar ou ser cancelada.
- Processo principal separado por domínio: `index.ts` só inicializa e compõe; os canais ficam em `src/main/ipc/` (autenticação, pessoa, PIS, CNPJ, CPI, manutenção, configurações) e a varredura do FULL AUTO em `cpi/full-auto-orchestrator.ts`. Os nomes de canal existem só no contrato tipado `src/shared/ipc-contract.ts`, usado pelo preload e pelo processo principal.
- Os canais de inspeção manual da CPI (inspecionar portal, filtro 29, linhas, detalhes, histórico da pessoa, preparar PDF) não são mais registrados no aplicativo instalado; continuam disponíveis no ambiente de desenvolvimento.
- O backup não trava mais a janela enquanto compacta: a compressão roda fora do processo principal e o CRC usa a implementação nativa do zlib. O formato do ZIP não mudou.
- O histórico da aba CPI lê os registros das 100 respostas mais recentes de uma só vez, em vez de um por um a cada pesquisa concluída, e deixa de competir com as gravações do agente.

### Corrigido
- CPI (validação real, pesquisa 542685/277705): uma falha antes do clique em "Alterar" ia para "envio sem confirmação" (verificação manual) e deixava o modal aberto; os ciclos seguintes falhavam no filtro. Agora o ponto de não retorno é gravado imediatamente antes do clique. Uma falha anterior fecha o modal sem salvar e a pesquisa é reprocessada depois com o mesmo PDF, sem nova consulta. "Envio sem confirmação" fica só para falhas depois do clique e pausa o agente na hora, com a pesquisa indicada na tela.
- 3 falhas seguidas antes do clique em "Alterar" pausam o agente. Um modal que não fecha sem salvar pausa na hora (portal bloqueado).
- CPI: o envio passou a seguir o DOM real do portal, capturado na validação. Fonte e Fonte 1º ficam como Desk Data e o Status como Respondida. O resultado é "Há Informações" (sem processos) ou "Sim, Consta Restrições" e nunca "Nada Consta" automático. O PDF é anexado e o nome do arquivo conferido no campo; "Permanecer nesta tela" fica desmarcado e o texto da resposta, vazio. O "Alterar" (link `upd_pesq()`) só é clicado depois do checkpoint gravado.
- CPI: o confirm do portal só é aceito com o texto esperado e o rótulo do resultado escolhido. Se o texto divergir, o envio é cancelado, o modal fecha sem salvar e a pesquisa vai para revisão ("confirmação divergente").
- CPI: a pesquisa só é concluída depois que o modal fecha e a listagem atualizada não mostra mais a pesquisa. Se o modal não fechar ou a pesquisa continuar listada, vira verificação manual e o agente pausa.
- CPI: requisições XHR/fetch do portal antes do clique deixaram de ser tratadas como envio precoce; só método e caminho vão para o diagnóstico. Só a recarga do formulário (iframe do modal) antes do clique é falha: o modal fecha sem salvar e a pesquisa fica pronta para reprocessar com o mesmo PDF.
- O diagnóstico passa a registrar o motivo fixo da falha no preenchimento (sem dados da pesquisa) e o nome dos canais com três partes (ex.: pausar o agente).
- Testes CPI comparavam caminhos temporários não canônicos; falhavam no runner Windows (TEMP com nome 8.3).
- Erros de lint (causa preservada em erros relançados, imports e variáveis sem uso).
- Geração de PDF podia travar indefinidamente; agora tem timeout total de 120 s (carregamento, fontes e `printToPDF`), destrói a janela de impressão e não grava arquivo parcial.
- Limpeza parcial de PDFs expunha na mensagem de erro o caminho do arquivo (que contém o CPF); agora a mensagem é genérica e mantém a contagem de PDFs excluídos.
- Marcadores de conflito de merge que tinham ficado neste CHANGELOG.
- Esperas externas sem limite podiam travar o agente. Cada operação CPI agora tem um prazo total: abrir, focar e fechar o navegador; filtro 29; leitura das linhas; abrir o detalhe; preencher, anexar e salvar; fechar o detalhe; reconciliar. Fechar o navegador ou sair da conta cancela a operação em curso na hora. Depois do prazo, a operação abandonada não clica nem grava estado.
- Prazo estourado ou cancelamento depois de anexar o PDF vira "envio sem confirmação" (verificação manual) e nunca reenvia. Antes do anexo, vira revisão sem nenhum envio.
- Deskdata: sair da conta cancela a requisição e o polling em curso; a mensagem pede para não repetir a consulta. O polling por código tem prazo total de 3 min (no máximo 24 tentativas, só GET). Mesmo um transporte que ignore o cancelamento não passa do prazo da requisição.
- Gravar o PDF ou conferir o PDF antes do anexo, numa pasta que não responde (ex.: unidade de rede), falha em 30 s. Nesse caso o caminho não é registrado e nada é anexado.
- Parar o monitor CPI com uma leitura presa termina dentro do prazo do filtro.
- Uma consulta recuperada em segundo plano podia trocar o PDF aberto por "Abrir PDF". O usuário podia então abrir o relatório de outra pessoa em vez do que estava na tela; agora a recuperação não altera esse PDF.

### Removido
- Arquivos do pnpm (`pnpm-lock.yaml`, `pnpm-workspace.yaml`); o projeto usa somente npm.
- Pacote `npm` listado indevidamente como dependência de runtime.
- Artefatos locais versionados por engano (CLAUDE.md, lote.diff, testes-removidos.txt).
- Limites locais de quantidade restantes: teto de 10.000 registros na fila CPI e de 100 linhas lidas por página.

### Inalterado
- Comportamento do aplicativo preservado.

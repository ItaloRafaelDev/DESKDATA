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
- Limites locais de quantidade restantes: teto de 10.000 registros na fila CPI e de 100 linhas lidas por página.

### Inalterado
- Comportamento do aplicativo preservado.

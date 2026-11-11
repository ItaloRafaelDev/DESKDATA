# CPI Central — integração controlada (v0.1.14-dev.1, fase 1)

## Escopo efetivamente implementado

- Nova área **Automação CPI** no renderer, protegida pelo login Deskdata existente.
- Abertura do Microsoft Edge instalado por meio do `playwright-core` (canal `msedge`), com sessão isolada e temporária.
- Login manual na CPI pelo usuário, sem coleta de senhas/cookies pelo DESKDATA.
- Inspeção **somente leitura** de atributos `tag`, `id`, `name`, `type` e `role` dos controles do domínio `adm.cpicentral.com.br`, incluindo frames desse domínio. Não captura valores de inputs, texto de resultados, JSON, CPF ou tokens; não grava inspeção em logs.
- Fechamento explícito do navegador, no logout Deskdata e na finalização do aplicativo.
- Regras puras testáveis para classificar processo criminal / demais situações / ausência de processos.
- Verificador preliminar de PDF por CPF do registro, tipo e estado da consulta, caminho cadastrado no histórico, pasta configurada, nome, arquivo real e assinatura `%PDF-`. Isso não comprova isoladamente o conteúdo interno do PDF; é necessário associar um hash imutável do PDF à consulta antes do envio automático em produção.

## Funcionalidades intencionalmente DESABILITADAS

- Seleção e leitura automática de solicitações do portal (aguardando mapeamento DOM).
- Qualquer POST à Deskdata por iniciativa do agente CPI.
- Upload, classificação e salvamento de registros CPI.
- Armazenamento de cookies de login CPI.
- Execução full-auto e fila persistente CPI.

## Premissas e bloqueios

- Os seletores reais do portal **não estão disponíveis**; nenhum endpoint interno da CPI foi presumido.
- O identificador CPI será ligado a um registro de pessoa da Deskdata, não apenas a um nome de arquivo.
- As regras de CPF, crédito e consulta permanecem nos serviços atuais, sem reimplementação paralela.
- A classificação de processos se dará pelos dados normalizados da API, não pelo texto do PDF. Como a resposta completa não fica persistida no histórico, ainda será preciso desenhar a recuperação por GET para classificações de PDFs reutilizados, com cuidado com dados sensíveis e consumo de créditos.
- O clique em Salvar CPI não será suficiente como comprovação: a etapa futura deverá inspecionar a confirmação da própria operação sem reabrir o registro. Resultados ambíguos não poderão ser reenviados automaticamente.
- Alterações a pastas, backups e eliminação de histórico precisam ser reconciliadas com a futura fila CPI antes de uso em produção.
- A sessão Edge temporária não sobrevive ao fechamento; login deve ser repetido na próxima inicialização.

## Validar no Windows

1. Criar a branch **local** `feature/cpi-automation` a partir de `main` e aplicar o patch apenas sobre a versão conferida.
2. `npm install` para obter `playwright-core` e demais dependências; não requer baixar navegador Playwright, mas exige Edge compatível instalado.
3. `npm run typecheck`, `npm test`, `npm run build`.
4. Iniciar com `npm run dev`, autenticar no DESKDATA, abrir **Automação CPI** e clicar **Abrir CPI no Edge**.
5. Fazer login manual e navegar até a tela de filtros. Clicar **Inspecionar controles DOM** e conferir os identificadores retornados. Testar edição de foco/aba sem executar nenhuma operação de escrita.
6. Fechar navegador e sair da conta Deskdata; verificar encerramento da sessão externa.
7. Não realizar operações pagas nem salvamentos na CPI nesta fase.

## Condições para a fase 2

Capturar seletor e evento de cada etapa: filtro, resultados, ID da solicitação, CPF completo, fonte/status/resultado, upload, confirmação e redirecionamento. Confirmar elegibilidade, autorização para automação e limite de créditos antes de execução de produção.

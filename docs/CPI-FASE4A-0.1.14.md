# DESKDATA v0.1.14 — CPI Fase 4A: verificação do histórico e PDF (somente leitura)

Esta etapa é posterior ao hotfix Fase 3B (identificação dos IDs e validação do CPF na janela de detalhe).

## Fluxo

1. Operador autentica CPI e Deskdata, aplica o filtro 29, mapeia a listagem e abre os detalhes da solicitação.
2. O botão **Verificar histórico e PDF** revalida a pesquisa e o CPF no detalhe ativo da CPI.
3. O Electron Main consulta **somente o histórico cifrado da conta Deskdata autenticada**, com o CPF mantido no processo principal.
4. A consulta de pessoa mais recente para o CPF é analisada; se estiver `ready`, o sistema valida a referência registrada e o cabeçalho do PDF na pasta configurada.
5. O renderer recebe só identificadores CPI, estado do vínculo e data da consulta, sem CPF completo, conteúdo do PDF ou caminho local.

Esta etapa **não** realiza HTTP GET/POST à Deskdata, não gera PDFs, não envia arquivos, não classifica resultados e não altera qualquer formulário na CPI. O prefixo `%PDF-` e o vínculo pelo histórico não constituem inspeção completa de conteúdo do relatório.

## Estados

- `no_history`: nenhuma consulta de pessoa existente na conta autenticada.
- `not_ready`: consulta mais recente ainda pendente, pausada ou incerta.
- `folder_unconfigured`: pasta de relatórios não definida.
- `pdf_unavailable`: PDF da consulta mais recente ausente ou não atende verificações preliminares.
- `pdf_available`: arquivo da consulta mais recente localizado na pasta permitida, com vínculo ao histórico e assinatura PDF preliminar.

Por segurança, **não recua para PDF mais antigo** caso a consulta mais recente não esteja pronta: é necessário definir política explícita de atualidade antes de liberar reaproveitamento automático e envio.

## Verificações

- `npm test`: suíte unitária e regressão, incluindo isolamento de conta, CPF divergente, ausência de arquivo e referências válidas.
- `npm run typecheck`, `npm run build`, `npm run dev`: executar no Windows com as dependências instaladas. Confirmar o novo botão e todos os estados do histórico.
- Teste real autenticado: selecionar uma solicitação da CPI e validar a indicação correspondente no Electron; **nenhum consumo de créditos**.

Nenhum commit ou push é realizado pelo patch.

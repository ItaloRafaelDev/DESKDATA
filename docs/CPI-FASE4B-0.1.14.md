# CPI Central - Fase 4B - Preparacao de PDF por historico / GET

## Objetivo

Integrar a pesquisa CPI 29 ja validada ao historico da mesma conta Deskdata, mantendo **desabilitado qualquer novo POST /queries** na automacao CPI. Esta etapa nao anexa arquivos ou salva respostas no portal.

## Execucao

1. Usuario autentica na Deskdata e na CPI e aplica filtro 29.
2. O Electron le IDs da linha, abre o formulario e valida a identidade (pesquisa, solicitacao, tipo, status e CPF).
3. Na Etapa 4, o botao **Preparar PDF pelo historico (GET)** consulta exclusivamente o historico local da mesma conta.
4. Havendo PDF da consulta mais recente, confirma arquivo na pasta configurada e assinatura basica `%PDF-`.
5. Havendo codigo de consulta mas PDF ausente ou pendente, usa o fluxo existente `resolveRecorded` (somente GET por codigo ja registrado, nunca POST). Se `202/4008`, devolve `pending` e o monitor ja existente acompanha o resultado.
6. Com GET concluido, valida o registro atualizado e o novo PDF antes de exibir `pdf_ready`.
7. Sem historico, responde `requires_paid_authorization` **sem iniciar consulta paga**.
8. Sem codigo recuperavel ou com registros inconsistentes, bloqueia a associacao.

## Seguranca

- CPF, caminho do PDF, payload bruto e codigo Deskdata nao atravessam o IPC da automacao CPI.
- Somente o processo Main le o CPF e o historico cifrado.
- Verificacao da identidade/estado CPI e repetida antes de tentar a recuperacao.
- Nao se executa JavaScript arbitrario do portal para gerar a consulta ou a resposta.
- O bloqueio de concorrencia impede recuperacoes simultaneas na mesma instancia.
- Nenhum PDF e transmitido ao portal nesta etapa.
- Nao reaproveitar PDFs de consultas mais antigas quando a consulta mais recente nao estiver pronta.
- A checagem da assinatura e vinculacao local do PDF e preliminar: nao substitui verificacao de completude dos datasets e da competencia judicial antes do envio.

## Contratos

Documentacao oficial: <https://docs.deskdata.com.br/reference/queries-results>

- GET `/queries/{query_code}`: resultado existente, HTTP 200 e codigo 4000.
- HTTP 202, codigo 4008: consulta ainda em processamento.
- Codigo Deskdata no formato `Q-XXXXXXXXXX` (caracteres hexadecimais).

## Estados exibidos

- `requires_paid_authorization`: nao ha consulta anterior; POST bloqueado.
- `folder_unconfigured`: pasta de PDFs nao selecionada.
- `manual_review`: historico sem PDF e sem codigo recuperavel.
- `pending`: GET existente segue em processamento.
- `pdf_ready`: PDF correspondente presente na pasta configurada; ainda nao anexado.

## Testes / pendencias

- Testes offline de retorno, falhas, divergencia de conta/CPF, GET simulado e validacao de arquivo.
- Typecheck e build devem ser executados no Windows com dependencias instaladas.
- Homologacao no Edge: cenarios sem historico e com codigo existente.
- Proxima fase: politica expressa de limite de creditos e nova consulta, qualidade do dataset, anexacao e salvamento supervisionados.

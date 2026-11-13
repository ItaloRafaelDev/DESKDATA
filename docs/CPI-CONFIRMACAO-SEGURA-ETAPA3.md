# CPI — confirmação segura de salvamento (Etapa 3)

Baseline: `55370714b82a0e0ec12ea8568b95ae00b96f9861`.

## Evidência disponível e limites

A implementação usa os controles já mapeados no adaptador e os sinais de resposta
descritos nos hotfixes 6A/6B/6D: identificação da solicitação e pesquisa, status,
resultado, data de resposta, indicação de Documento PDF e ausência de upload editável.
Não houve acesso ao portal autenticado nesta etapa. As páginas de teste são fixtures;
não constituem novas capturas nem homologação de templates reais.

O mesmo leitor DOM e os mesmos parsers de IDs atendem leitura, upload e confirmação.
São preservados os títulos com/sem `da`, os separadores conhecidos e a leitura de
`h1,h2,h3,.mt` e linhas completas de títulos. IDs são comparados integralmente.
A Shadowbox ativa tem prioridade. Frames de outras pesquisas, frames substituídos
e títulos ambíguos não fornecem evidência para o envio atual.

## Regra de conclusão (v0.2, E6 — DOM real do portal)

A captura do DOM real feita na E6 (13/11) mostrou que o portal não tem `__doPostBack` nem formulário associado
aos campos (`form: null`). O "Alterar" é um link de texto (`<a href="javascript://" onclick="upd_pesq()">`), Status e
Resultado chamam só funções locais (`change_status`, `change_consta`) e o portal não devolve uma página com os
campos persistidos depois de salvar. Por isso a regra de conclusão do envio passou a ser:

1. cabeçalho do modal (solicitação e pesquisa) e CPF conferidos antes de preencher e revalidados a cada passo;
2. `id_pesquisador` e `id_pesquisador_prim` = Desk Data; `id_pesq_status` = Respondida; o radio de resultado
   (`#consta2` "Há Informações" ou `#consta3` "Sim, Consta Restrições") e `#MainPage_FileUpload1` visíveis no prazo;
3. radio marcado e conferido; arquivo anexado e conferido (`files[0].name` = nome do PDF `CPI_` do item);
   `#stay` desmarcado; `textarea#resposta` nunca é preenchido; "Nada Consta" nunca é automático;
4. `submit_started` gravado antes do clique (sem checkpoint gravado, não há clique);
5. o confirm nativo só é aceito com o texto "Deseja Realmente Alterar esta Pesquisa?" e `Resultado >>> <rótulo>`
   do resultado escolhido. Texto divergente é cancelado (`upd_pesq` não envia): `confirm_mismatch` →
   `review_required` ("confirmação divergente") e o modal é fechado sem salvar;
6. depois do clique, o modal (`#sb-container` com o iframe `#sb-content`) fecha no prazo;
7. a listagem aguardando é atualizada e nenhum checkbox `#pesq_N` tem valor terminado em `;<solicitação>;<pesquisa>`.
   Só então o item vira `completed`.

Modal que não fecha (6) ou item que continua listado (7) → `verification_required` e o FULL AUTO pausa na hora,
sem reenvio. Alert do portal depois do clique também é resultado incerto.

Antes do clique, XHR/fetch do portal não é falha: o diagnóstico registra só método e caminho (sem query string,
sem IDs longos). Só a navegação ou recarga do iframe `#sb-content` é falha (`CpiFrameReloadError`): o modal é
fechado sem salvar e o item continua em `pdf_ready`.

As regras de evidência persistida abaixo (fonte, data, Documento PDF, IDs exatos na página) **continuam valendo
apenas para a reconciliação manual** (`inspectPersistedPersonResponse`), que reabre a pesquisa por GET sem salvar.

## Regra de evidência persistida (reconciliação)

Na reconciliação, a pesquisa só é dada como respondida quando se confirma, em conjunto:
(os itens 2 a 5 descrevem o envio antigo por formulário e ficam como registro histórico; a reconciliação usa
os itens 1 e 6)

1. CPF e IDs conferidos antes do preenchimento e IDs/CPF revalidados antes de salvar;
2. anexo e botão Alterar vinculados ao mesmo formulário;
3. ação HTTPS desse formulário contendo os IDs exatos nos parâmetros já mapeados
   `id_sol` e `id_pesq_tipo`, cada um uma única vez;
4. uma única requisição POST de navegação desse frame para essa ação, observada
   durante o clique atual, com resposta HTTP 2xx correlacionada pelo objeto Request;
5. diálogo de confirmação observado e navegação do mesmo frame;
6. documento resultante na URL esperada com IDs exatos, status Respondida,
   classificação esperada, fonte Desk Data, data de resposta, indicação de Documento PDF e sem
   campo de upload editável, sem erro bloqueante observado.

Outra requisição de navegação ou uma segunda navegação do frame invalida a
correlação, inclusive GET para a mesma URL. Resultado e indicação de PDF exigem
o texto esperado integralmente, sem prefixos genéricos que aceitem negações.
A data de resposta deve representar uma data válida no calendário.

HTTP de sucesso, confirm aceito, sumiço do formulário e fechamento da modal,
isolados ou juntos, não concluem a pesquisa. Redirecionamentos, inclusive para
login, permanecem inconclusivos. Nenhuma requisição extra de confirmação é enviada.
O 404 auxiliar conhecido de `cpi_api_request.aspx` continua como aviso somente
quando todas as demais evidências positivas estão presentes.

Os campos persistidos devem ser identificáveis univocamente nas linhas `.row`
e células `.cell`/`td` já usadas pelo adaptador. Ausência ou ambiguidade bloqueia a
conclusão. POST por AJAX, ação sem IDs observáveis, troca do iframe durante o envio,
ou outro mecanismo não correlacionável exigem revisão, sem supor equivalência.

A indicação Documento PDF comprova apenas o que a interface apresenta. Não há
contrato observado para verificar hash, bytes, nome ou conteúdo do arquivo remoto,
nem confirmação independente de durabilidade do banco CPI ou de webhook externo.
O retorno somente leitura de Pesquisador/Fonte não foi homologado no portal real:
se ele não expuser Desk Data de forma unívoca, a pesquisa permanece não concluída.
As fixtures positivas incluem esse campo apenas para exercitar a regra, sem alegar
que todos os templates reais o disponibilizam. Para prova dos bytes remotos ou da
durabilidade independente, o contrato precisa ser esclarecido antes da homologação.

## Checkpoints e falhas

O workflow grava `pdf_ready` antes de chamar o adaptador. **Desde a v0.2 (E6, fix/v02-validacao-anexo-pdf)**
`submit_started` é gravado pelo adaptador (`beforeSubmit`) depois do anexo conferido e imediatamente antes do
clique em "Alterar"; sem o checkpoint gravado não há clique. As regras abaixo foram ajustadas a esse ponto.

- `not_submitted`: falha antes do clique em "Alterar" (campo ausente, radio ou anexo não confirmados, recarga do
  iframe `#sb-content`, identidade alterada). O modal é fechado sem salvar (`a#sb-nav-close`) e o item permanece em
  `pdf_ready`: é reprocessado depois (adiado em memória) com o MESMO PDF e a mesma classificação, sem POST, sem GET
  e sem regerar o PDF. 3 seguidas pausam o agente (`submit_not_sent`).
- XHR/fetch do portal antes do clique não é falha (só método e caminho no diagnóstico, evento `cpi_portal_request`).
- `confirm_mismatch`: texto do confirm divergente; cancelado, nada enviado. Modal fechado sem salvar e item em
  `review_required` ("confirmação divergente"); nunca reprocessado automaticamente.
- Depois do checkpoint (`submit_started`), qualquer falha é `unverified` → `verification_required`. O modal é
  mantido aberto para a verificação manual e o FULL AUTO pausa na hora.
- Se o modal não fechar sem salvar, o portal fica bloqueado: parada sistêmica (`portal_layout`).
- O motivo de cada falha antes do clique vai ao diagnóstico como `errorType` de lista fixa
  (`CpiFrameReloadError`, `CpiResultRadioError`, `CpiFileInputError`, `CpiAttachRejectedError`, `CpiSaveButtonError`, ...).
- Exceção não classificada após o checkpoint também grava `verification_required`.
- Se houver interrupção antes dessa gravação, `submit_started` permanece bloqueante.

Após reinício, esses estados são lidos antes de abrir a pesquisa ou consultar a
Deskdata. Nenhum novo POST, anexo ou clique Alterar é disparado. PDF, vínculo de
histórico e classificação são preservados. A reconciliação é manual; esta etapa
não introduz ferramenta que libere reenvio nem resolve automaticamente workflows
antigos já marcados como completed.

## Verificação

Os testes de navegador usam o Edge instalado com todas as rotas interceptadas e
respondidas localmente; não usam cookies/credenciais reais e nunca encaminham uma
requisição ao portal. Exercitam DOM, frames, seletores, navegação, diálogos e POSTs
fictícios com o adaptador real. Os bytes do arquivo selecionado são observados no
navegador; a API de interceptação não fornece prova de armazenamento remoto.
Testes de recuperação usam workflow e PDF em diretórios temporários.

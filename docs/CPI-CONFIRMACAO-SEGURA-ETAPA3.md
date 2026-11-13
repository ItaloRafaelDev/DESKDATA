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

## Regra de conclusão

`completed` só é gravado após o adaptador confirmar, em conjunto:

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

- `not_submitted`: falha antes do clique em "Alterar", sem POST ou navegação do portal observados. O modal é
  fechado sem salvar e o item permanece em `pdf_ready`: é reprocessado depois (adiado em memória) com o MESMO PDF
  e a mesma classificação, sem POST, sem GET e sem regerar o PDF. 3 seguidas pausam o agente (`submit_not_sent`).
- `not_submitted_postback`: o portal fez POST ou navegação no frame antes do clique (o agente não salvou nada, mas
  o formulário pode ter sido enviado pelo próprio portal). Modal fechado sem salvar e item em `review_required`;
  nunca reprocessado automaticamente.
- Depois do checkpoint (`submit_started`), qualquer falha é `unverified` → `verification_required`. O modal é
  mantido aberto para a verificação manual e o FULL AUTO pausa na hora.
- Se o modal não fechar sem salvar, o portal fica bloqueado: parada sistêmica (`portal_layout`).
- O motivo de cada falha antes do clique vai ao diagnóstico como `errorType` de lista fixa
  (`CpiEarlyPostbackError`, `CpiFileInputError`, `CpiSaveButtonError`, `CpiFormActionError`, ...).
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

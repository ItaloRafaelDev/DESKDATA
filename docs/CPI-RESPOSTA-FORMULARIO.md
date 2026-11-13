# CPI — Resposta do formulário (v0.2)

Substitui a regra de conclusão do salvamento descrita em `CPI-CONFIRMACAO-SEGURA-ETAPA3.md`, que foi desenhada
sobre fixtures sem acesso ao portal e exigia uma página persistida nunca observada no portal real.

## Sequência (`cpi-browser.ts`, `saveResponse`)

Seletores em `src/main/cpi/form-selectors.ts`, vindos do projeto AGENTE_PESQUISA_FORUM_NACIONAL (portal real):

1. Status `select[name="id_pesq_status"]` = "Respondida".
2. Aguardar o radio do resultado (`#consta2` Há Informações, `#consta3` Sim, Consta Restrições).
3. Pesquisador/Fonte `select[name="id_pesquisador"]` = "Desk Data". A Fonte 1º não é alterada.
4. Resultado pelo `label[for]`; "Nada Consta" (`#consta1`) nunca fica marcado. "Permanecer nesta tela" desmarcado.
5. Conferir os três campos; até 3 tentativas (a troca de Status pode recarregar o bloco).
6. Anexar o PDF em `#MainPage_FileUpload1` e conferir o nome; reaplicar e conferir os campos.
7. Clicar em Alterar (`form[name="form_cad"] a.button[onclick*="upd_pesq"]`) e aceitar somente o confirm
   "Deseja Realmente Alterar esta Pesquisa?". Outro diálogo é cancelado.

## Resultado do adaptador

- `not_submitted`: falha antes do clique e sem POST do frame depois do anexo. Item vai para revisão.
- `unverified`: POST observado após o anexo, prazo/cancelamento após o clique, login, página de erro, HTTP ≥ 400,
  alert ou texto de erro na resposta. Item vai para verificação manual. Nunca há reenvio.
- `confirmed`: confirm aceito e o formulário foi deixado (iframe navegou ou sumiu, ou o modal fechou) sem erro.
  **Não é prova de persistência.**
- `dry_run_ok`: modo ensaio; o confirm foi cancelado.

## Prova de conclusão (`closeCompletedDetail`)

Fecha a Shadowbox pelo controle `Shadowbox.close()` se o portal não voltou sozinho e executa
`refreshPendingAfterConfirmedSave`: a pesquisa só é `completed` quando some da listagem de pendentes em duas leituras
iguais. Caso contrário, permanece em revisão, sem reenvio.

## Modo ensaio

`npm run dev` com `DESKDATA_CPI_ENSAIO=1` (ignorado quando `app.isPackaged`). Uma pesquisa por execução: preenche,
anexa, cancela o confirm, fecha o modal sem salvar e pausa o agente. O item permanece em `pdf_ready` e, no modo real,
é retomado por GET pelo código da consulta, sem novo POST na Deskdata.

## Limites

Os testes usam um portal simulado com os seletores acima; não constituem homologação. A validação é manual no portal
real: ensaio em 2 pesquisas, 1 pesquisa real e um lote de 3 a 5.

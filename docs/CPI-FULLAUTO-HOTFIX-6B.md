# Hotfix 6B - confirmacao CPI e erro auxiliar 404

## Diagnostico

Na interface real, a CPI exibe **Respondida**, resultado correto, horario da resposta e **Documento PDF** na mesma solicitacao, mas simultaneamente abre um erro HTTP 404 indicando `URL solicitada: /cpi_api_request.aspx`. O Hotfix 6A verificava o texto completo do documento, de modo que um erro de recurso auxiliar invalidava toda a confirmacao.

## Correcao

- A falha 404 *especifica e conhecida* de `/cpi_api_request.aspx` e classificada como **aviso auxiliar**, nao como falha comprovada do POST de salvamento.
- Outras falhas HTTP, erros do proprio POST/alertas e respostas sem os IDs/Status/Resultado/Data/PDF continuam bloqueando a conclusao.
- A confirmacao ainda exige `confirm` aceito e HTTP de sucesso do POST principal; nenhum GET ou POST adicional e disparado.
- Apos confirmacao positiva, fecha a janela Shadowbox e agenda nova varredura da fila. Se o fechamento falhar ou o resultado for inconclusivo, pausa sem reenviar.
- O resumo de execucao mostra o aviso 404 para acompanhamento operacional. Esse aviso pode indicar falha de webhook ou outra integracao do portal; verificar com a CPI/4Link, sem presumir que a entrega externa foi realizada.

## Validacao

A suite automatizada usa simulacoes de estados do portal. **A execucao autenticada com varias pesquisas no Windows ainda deve ser verificada.**

## Operacao segura

Se uma pesquisa ja foi salva e aparece como `Respondida`, nao clicar novamente em Alterar. Antes de instalar, pausar, fechar a modal manualmente e encerrar o Electron. Nao descartar o historico cifrado e nao reiniciar consultas pagas inadvertidamente.

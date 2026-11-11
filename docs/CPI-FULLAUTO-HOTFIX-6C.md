# DESKDATA CPI — Hotfix 6C: sincronização entre respostas

Escopo: aplicar sobre **v0.1.14 + Hotfix 6B** em `feature/cpi-automation`.
Não altera autenticação, datasets, orçamento de créditos, classificação, PDFs, upload ou POST de salvamento.

## Causa e comportamento

O portal CPI pode deixar a lista de pesquisas pendentes desatualizada após fechar a janela Shadowbox da solicitação respondida. A versão anterior aceitava a conclusão logo após `Shadowbox.close()`, sem exigir que a listagem excluísse a pesquisa respondida. O método **Mostrar Tudo** é o controle mapeado para atualizar a lista.

A captura do usuário também mostra um erro na segunda solicitação, mas não inclui a exceção original. Este hotfix corrige a sincronização confirmada e passa a exibir a mensagem de falha com dados potencialmente sensíveis mascarados. Não presume que qualquer falha posterior tenha necessariamente essa mesma causa.

## Comportamento após uma resposta confirmada

1. Fechar a Shadowbox do registro concluído, uma única vez.
2. Aguardar o modal ficar oculto e a tela de pendentes estar ativa.
3. Acionar **Mostrar Tudo** uma vez, sem reabrir a pesquisa concluída.
4. Inspecionar rodapé e IDs da listagem, exigindo duas leituras consecutivas estáveis, sem o ID já respondido.
5. Somente então concluir a transição para o ciclo seguinte.
6. Caso a CPI não confirme a nova lista em até 20 segundos, pausar sem reenviar PDF/POST. O registro permanece `completed` na fila persistente.

## Evidências e limites

- Testes locais: `npm test` da suíte geral; execução no browser CPI real pendente.
- `npm run typecheck`/build: dependem de Node/Vite e demais pacotes instalados no Windows; não foram aprovados no ambiente isolado.
- Não corrigimos o erro HTTP 404 do recurso auxiliar `/cpi_api_request.aspx`: continua sendo uma ocorrência externa a investigar.
- Nenhum commit, push ou alteração de registros reais no portal foi realizado ao preparar o patch.

## Homologação manual

1. Verificar `git branch --show-current` e executar `npm run typecheck`, `npm test`, `npm run build`.
2. **Não reiniciar o processamento de solicitações já respondidas** nem apagar o estado cifrado `cpi-workflows.bin`.
3. Com solicitação de teste nova, saldo e orçamento aprovados, acompanhar a CPI: a primeira resposta deve ficar como `Respondida` com PDF.
4. A Shadowbox deve fechar e **Mostrar Tudo** deve atualizar a listagem; a solicitação concluída não pode aparecer na lista ativa de pendentes.
5. O agente deve iniciar a próxima pesquisa automaticamente apenas depois dessa confirmação.
6. Em caso de erro, registrar a **nova mensagem específica exibida no Electron** sem CPFs, nomes, tokens ou cookies. O agente deve permanecer pausado, sem reenvio.

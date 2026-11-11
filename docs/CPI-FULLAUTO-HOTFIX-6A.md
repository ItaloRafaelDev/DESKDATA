# DESKDATA CPI — Hotfix 6A: fechamento e avanço da fila

## Problema confirmado no código
O ciclo anterior aceitava como sinal de confirmação que o formulário fosse removido. A CPI pode manter a janela Shadowbox aberta, exibindo a resposta persistida em modo leitura. Isso impedia a transição para outra solicitação.

## Alterações
- Reconhecer resposta persistida por ID da solicitação e pesquisa, status Respondida, resultado esperado, data de resposta, PDF anexado e inexistência do campo de upload editável. Exige também confirmação da operação via POST e confirmação do diálogo.
- Não considerar erro HTTP ou iframe vazio dentro de modal aberto como sucesso.
- Após persistir a etapa `completed`, fechar exclusivamente a janela de pesquisa via controle `title=Fechar` com `onclick=Shadowbox.close()` e aguardar que o modal fique oculto.
- Se o fechamento falhar, pausar para intervenção manual; não repetir POST nem upload.
- Se uma solicitação foi concluída e ainda havia outras na listagem, agendar nova varredura em 2 segundos. Se não houver mais solicitações, respeitar o intervalo configurado.
- Nenhum acesso ao histórico de respondidas na CPI; o agente reaplica o filtro de pendentes depois de fechar o modal.

## Não incluído
Nenhuma alteração nas regras de classificação, no consumo de créditos, nas credenciais, nos datasets ou na geração de PDFs.

## Validação
Executados offline 188 testes com Node 22, todos aprovados. Testes reais no portal e typecheck completo continuam pendentes no Windows. Nenhum commit ou push foi realizado.

## Homologação
Após aplicar o patch e validar typecheck, testes e build no Windows, usar duas solicitações de teste. A primeira deve concluir, a janela Responder / Atualizar Pesquisa deve fechar e o agente deve abrir a seguinte após atualizar a listagem. Se a janela falhar ao fechar, o agente deve pausar sem reenvio. Verificar que as pesquisas estão respondidas e PDFs associados, sem duplicidade.

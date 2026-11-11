# DESKDATA — CPI Central: fase 3A (monitoramento seguro da pesquisa 29)

## Base e evidências

- Reconstruída a partir da v0.1.13 + Fase 1 + Fase 2 + hotfix de clique no checkbox 29.
- O usuário validou no Edge (04/11/2026) a sequência de Filtros Avançados -> tipo 29 -> Selecionar -> Mostrar Tudo e o estado de zero pesquisas.
- O DOM de **linhas com pesquisas pendentes** e o formulário de detalhes **não foram observados nem validados** no ambiente desta entrega. Não há dados suficientes para selecionar um registro ou extrair CPF sem risco de associar pessoas incorretamente.

## O que foi implementado

1. Monitoramento iniciado manualmente após autenticação CPI, com intervalos configuráveis de 30, 60, 120 ou 300 segundos; padrão 60 segundos.
2. Usa a filtragem validada de tipo 29 em uma única aba Edge já aberta.
3. Espera a conclusão do ciclo antes de agendar o seguinte; não faz consultas concorrentes.
4. Quando o rodapé indicar total zero, apresenta estado **Aguardando próximo ciclo** (não é erro).
5. Quando houver total positivo, interrompe o monitor em **Solicitações detectadas — aguarda mapeamento DOM**; não abre, consulta ou responde nenhuma solicitação.
6. Quando a contagem não for verificável, houver erro de sessão/navegação ou inconsistência entre estado e total, interrompe com **Erro**; não assume que a lista está vazia.
7. IPC tipado para iniciar, pausar, consultar estado e receber atualizações, com validação de origem feita pelo fluxo IPC já existente.
8. Pausa e parada durante fechamento do navegador, logout e encerramento do aplicativo; sem gravar cookies ou CPFs.
9. Interface com estados de execução, número de verificações, última e próxima verificação e último total informado.

## Fora do escopo desta entrega

- Leitura de identificadores por linha, captura do CPF, fila persistente, deduplicação de solicitações, abertura de registros, execução de POST/GET Deskdata, classificação aplicada na CPI, anexação de PDF e salvamento.
- FULL AUTO completo: **não habilitado**. A evolução para a fase 3B exige evidência de uma linha real e seu DOM, inclusive a forma de abertura dos detalhes. A fila persistente somente deve ser implementada depois de termos chaves estáveis comprovadas.
- Sem commit ou push no projeto do usuário: aplicar patch somente na branch local `feature/cpi-automation`.

## Critérios de validação no Windows

1. `npm run typecheck`, `npm test` e `npm run build` devem passar com as dependências instaladas.
2. Abrir DESKDATA, autenticar-se e acessar Automação CPI; abrir Edge e autenticar na CPI.
3. Iniciar monitoramento de 60 segundos. Deve aplicar filtro 29, mostrar última verificação e, quando vazia, agendar a próxima.
4. Verificar a execução de pelo menos **dois ciclos** sem cliques adicionais.
5. Usar Pausar; aguardar e confirmar que não executa outro ciclo; depois reiniciar.
6. Fechar o navegador enquanto em espera; verificar que o monitor para sem exceções não tratadas.
7. Simular sessão expirada sem expor credenciais e verificar estado de erro, sem repetir operações.
8. Quando houver pesquisa real pendente, confirmar que o total é positivo e que o estado se torna **aguarda mapeamento DOM**; capturar HTML estrutural dos identificadores e ações para a fase 3B, ocultando CPF/dados pessoais.

## Testes desta entrega

- `npm test`: 121 testes aprovados no ambiente de construção Linux, incluindo oito novos testes do monitor.
- `git diff --check`: aprovado.
- `npm run typecheck`/`npm run build`: **não executáveis neste ambiente** devido à ausência de dependências do projeto (`@types/node`, `vite/client`, Electron etc.). Validação obrigatória no Windows.

## Riscos remanescentes

- A CPI pode atualizar a contagem de maneira assíncrona. Sem contrato HTTP documentado, a captura do rodapé após Mostrar Tudo ainda precisa ser observada em ciclos reais; não presumir resultados positivos como garantia de elegibilidade linha a linha.
- Uma verificação já iniciada pode concluir depois de pressionar Pausar; não será agendada uma nova execução.
- Não autorizar integração com consultas pagas nem envio automático enquanto não houver confirmação dos identificadores, estados e contrato de salvamento do portal.

# DESKDATA CPI — Painel operacional e histórico (v0.1.14)

## Escopo

- Mantidos: módulo de consulta pessoa, PIS, CNPJ, filtro CPI 29, FULL AUTO,
  confirmação de resposta, fechamento e atualização da listagem (hotfix 6C).
- Removida da execução CPI: a restrição local `maxNewQueries` e o saldo mínimo
  configurável. O arquivo cifrado legado `cpi-automatic-budget.bin` não é lido
  pela automação e não será apagado pelo instalador.
- Mantidos: autorização geral por conta em **Minha conta**, confirmação para
  iniciar o agente, saldo Deskdata `GET /credits` antes de cada novo POST,
  uma solicitação por vez, prevenção de consultas e envios duplicados.
- Saldo igual a zero pausa novos POSTs; saldo positivo não garante que cobre
  os datasets: a API pode rejeitar `403 / 4003` e o agente deve interromper.
  Não há retry automático de POST após resultado incerto.
- O painel CPI é único: abertura do Edge, iniciar/pausar, intervalo, estado,
  créditos e histórico de registros concluídos pelo agente. Ferramentas de
  inspeção DOM continuam disponíveis apenas internamente para manutenção.

## Histórico

`cpi:history:list` lê `cpi-workflows.bin`, cifrado e separado por conta.
Exibe apenas os 100 registros **concluídos** mais recentes, com total geral,
classificação e momento de conclusão. O contador de revisão inclui estados
`verification_required`, `review_required` e `submit_started`. Não retorna
CPF, tokens nem caminhos do PDF ao renderer. O botão Abrir PDF resolve o
vínculo pelo ID da pesquisa e solicitação e confere o arquivo novamente no
processo principal antes de abrir no leitor padrão.

## Teste mínimo em Windows

1. Salvar uma cópia privada do projeto antes do patch; executar `git status`.
2. Aplicar patch apenas na branch local `feature/cpi-automation`.
3. `npm run typecheck`, `npm test`, `npm run build`, `npm run dev`.
4. Abrir a aba Automação CPI; verificar histórico concluído e PDFs.
5. Confirmar que a autorização em Minha conta é necessária; iniciar o agente
   com sessão Edge autenticada e dados de teste autorizados.
6. Verificar que a quantidade de consultas não depende mais do teto antigo,
   mas a API ainda é consultada por saldo e interrompe em saldo insuficiente.
7. Executar duas solicitações consecutivas para verificar fechamento do modal,
   nova listagem e vínculo correto dos arquivos sem duplicidade.
8. Testar expiração de sessão, retorno HTTP 403/4003 e revisão de envios incertos
   sem executar novos POSTs nem respostas reais não autorizadas.

**Limites dos testes offline:** não validam execução Electron/Edge/portal CPI
nem consumo real de créditos. Não declarar homologação de produção sem esses
resultados. Nenhum commit/push automático.

# DESKDATA v0.1.14 — Ajustes de interface da Fase 3A

## Origem

- Atualização incremental sobre v0.1.13 + CPI Fase 1 + Fase 2 + hotfix do checkbox + Fase 3A.
- O monitoramento automático de listagem CPI 29 já foi validado em execução real pelo usuário em 10/11/2026 com contagem zero.
- O usuário solicitou intervalo manual, temporizador visível e habilitação progressiva dos botões.

## Comportamento implementado

1. Intervalo digitado manualmente em **segundos**, aceitando qualquer valor inteiro entre **30 e 86.400** (24 horas), inclusive valores como 45 e 900; padrão 60.
2. Validação idêntica no renderer e no processo principal; não inicia monitoramento para entradas inválidas, fracionárias ou fora da faixa.
3. Contagem regressiva visível até a próxima verificação, atualizada a cada segundo, a partir do `nextCheckAt` informado pelo monitor do processo principal. Nenhum timer extra envia requisições à CPI.
4. Quando o monitor efetivamente executa uma verificação, a interface exibe **Verificando a CPI neste momento...**, sem sugerir que o horário programado garante finalização imediata.
5. Enquanto o Edge está aberto, **Abrir CPI no Edge** fica desabilitado; **Filtrar**, **Inspecionar** e **Iniciar monitoramento** são liberados conforme o estado operacional. Durante o monitoramento os botões de filtro e inspeção permanecem bloqueados. **Pausar** fica disponível somente enquanto o monitor está ativo.
6. A interface atualiza o estado do navegador a cada 5 segundos enquanto a aba Automação CPI está aberta, inclusive quando o Edge é fechado manualmente.
7. Alterar o intervalo durante a execução exige pausar e iniciar novamente. O backend continua executando uma verificação por vez e só agenda outro ciclo após concluir o anterior.

## Fora do escopo

- Não lê linhas ou CPFs, não acessa detalhes, não faz POST/GET Deskdata, não anexa PDFs, não salva respostas na CPI e não publica alterações no GitHub.
- A Fase 3B continua condicionada ao mapeamento confiável do DOM de uma linha real de pesquisa pendente.

## Verificações

- `npm test`: 124 testes aprovados no ambiente de criação, incluindo três novos testes das funções de intervalo/temporizador.
- Transpilação sintática isolada dos arquivos TypeScript alterados: aprovada.
- `git diff --check`: aprovado.
- `npm run typecheck` e build: pendentes neste ambiente, sem dependências de desenvolvimento instaladas; executar no Windows.
- Teste visual e execução real dos controles atualizados no Electron/Edge: pendentes de confirmação do usuário.

## Teste manual de aceite no Windows

1. Aplicar o patch somente na branch local `feature/cpi-automation`, sem commit/push.
2. Validar `npm run typecheck`, `npm test`, `npm run build`, `npm run dev`.
3. Antes de abrir Edge: **Filtrar**, **Inspecionar**, **Fechar** e **Iniciar** desabilitados.
4. Após abrir Edge: **Abrir** desabilitado; **Filtrar**, **Inspecionar** e **Iniciar** disponíveis. Autenticar na CPI manualmente.
5. Informar **45** segundos, iniciar: primeira verificação; depois de listagem vazia, temporizador de aproximadamente `00:45` diminui a cada segundo. Validar dois ciclos.
6. Pausar: temporizador desaparece e não ocorre novo ciclo. Digitar **90** e reiniciar: próximo ciclo deve ocorrer após ~90 segundos a contar da conclusão da verificação.
7. Digitar `10`, campo vazio ou `30.5`: impedir **Iniciar** e sinalizar intervalo inválido.
8. Fechar navegador: botão **Abrir** volta a ficar disponível quando estado for atualizado (até 5 s).
9. Quando aparecerem registros, o monitor deverá continuar pausando em **needs_mapping** sem abrir ou modificar solicitações.

## Reversão

Aplicar reversão do patch individual: `git apply -R -- <arquivo.patch>`, executando a partir da pasta do projeto e somente se não houver novas alterações conflitantes.

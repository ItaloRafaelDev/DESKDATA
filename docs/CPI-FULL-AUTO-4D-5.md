# DESKDATA v0.1.14 — Fase 4D/5: ciclo automático CPI 29 (pré-homologação)

## Escopo

- Ler filtro 29 na CPI Central via Microsoft Edge/Playwright, uma solicitação por ciclo.
- Abrir o formulário e confirmar solicitação, pesquisa, CPF e status **Aguardando Pesquisa**.
- Recuperar via GET um código de consulta já registrado; se não existir histórico, reservar autorização/limite antes de enviar **um único POST /queries**.
- Validar identidade do resultado, datasets e competência judicial; não associar PDF se a validação falhar.
- Gerar PDF A4 na pasta configurada, guardar o caminho no histórico e validar o arquivo pela referência exata.
- Preencher Fonte, Status, Resultado e anexo PDF no formulário CPI e confirmar o diálogo Alterar.
- Não reabrir solicitações respondidas. Se não houver confirmação suficiente do envio, marcar **Verificação necessária**, nunca repetir o upload automaticamente.
- Manter fila e orçamento cifrados no Windows, com isolamento por conta e por identificadores de pesquisa/solicitação; backup inclui os dois arquivos cifrados.

## Regras de classificação

- `lawsuits` completo com ao menos um `court_type: Criminal`: **Sim, Consta Restrições**.
- Processos exclusivamente não criminais ou ausência confirmada de processos: **Há Informações**.
- Dataset ausente/erro, CPF divergente ou competência sem identificação: **Revisão necessária**; não salvar.

A categoria é uma decisão operacional da CPI; não comprova culpa ou condenação.

## Proteções

- Novo POST exige autorização geral, habilitação CPI, saldo mínimo e limite disponível. Reserva persistida antes do POST, nunca devolvida automaticamente após erro incerto.
- `GET /queries/{query_code}` para consultas existentes ou pendentes. Não repetir POST sem código, mesmo após timeout.
- Uma única sessão Edge e processamento sequencial. Login CPI manual. Limite de monitoramento: 30–86400 s.
- A fila persistente marca `submit_started` antes da ação irreversível e impede segundo envio; `completed` requer confirmação observável na mesma operação.
- A operação não será considerada concluída apenas por ter clicado em Alterar.
- Logs não incluem CPF, senha, tokens, documento ou conteúdo do resultado.

## Homologação obrigatória no Windows

1. `npm run typecheck`, `npm test`, `npm run build`.
2. Login nas duas plataformas; conferir configurações de conta/limite, pasta de PDF e abertura da solicitação correta.
3. Com pesquisa de teste autorizada, confirmar valores disponíveis dos selects Fonte, Status, radios Resultado e campo de upload PDF.
4. Confirmar diálogo e resposta de rede do endpoint de atualização; observar se os sinais de sucesso usados no código realmente correspondem a persistência.
5. Ensaiar falhas: ausência de PDF, ausência de código, CPF divergente, token expirado, resposta 202, upload interrompido, serviço CPI indisponível e reinício durante a operação.
6. Validar que o item concluído não gera novo POST nem novo anexo e que `verification_required` permanece bloqueado após reiniciar.
7. Testar mais de uma solicitação, paginação e execução por um período longo antes de homologar FULL AUTO.

## Situação da entrega

Código integrado e testes unitários/offline executados. **Ainda não foi homologado ponta a ponta na CPI e na Deskdata**, nem submetido a qualquer operação paga real. O portal CPI não disponibiliza documentação pública do formulário de salvamento; os seletores foram fundamentados nas capturas do usuário, mas dependem de validação em uma sessão autenticada. Em caso de falha de mapeamento a automação deve interromper o envio, não tentar preenchimento aproximado.

Não realizar commit/push até autorização explícita do usuário.

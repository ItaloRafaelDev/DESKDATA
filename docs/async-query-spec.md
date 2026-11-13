# DESKDATA v0.1.6 — acompanhamento assíncrono

## Requisitos
- Consultar pessoa e Consultar CNPJ devem devolver estado `pending` para HTTP 202/4008 sem bloquear o formulário por minutos.
- A operação POST deve ocorrer no máximo uma vez por nova solicitação; registrar o código Q-XXXXXXXXXX cifrado antes de consultar novamente.
- Recuperação automática via GET por código conhecido, com intervalos crescentes, limite de tentativas e no máximo duas recuperações simultâneas.
- O estado pendente deve persistir após reinício; retomar somente após autenticação da mesma conta.
- O PDF deve ser gerado e associado ao registro original quando a API responder 200/4000 e a identidade for validada.
- Erros não devem criar novos POSTs; indisponibilidade prolongada/expiração de sessão pausam a recuperação, mantendo opção manual.
- UI deve mostrar estado e atualizar histórico automaticamente, sem ocultar o botão Abrir PDF.
- Consultar PIS permanece inalterado.
- Nenhuma consulta real ou consumo de créditos durante testes.

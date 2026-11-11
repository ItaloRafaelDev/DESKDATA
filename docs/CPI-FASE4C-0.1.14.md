# DESKDATA v0.1.14 — CPI, Fase 4C: controle de novos POSTs

## Escopo

Esta entrega acrescenta uma autorizacao local por conta Deskdata, independente da aprovacao geral de consultas manuais.

- A autorizacao CPI inicia **desativada**, com zero tentativas disponiveis.
- O operador configura um **limite de novas consultas**, de 0 a 1000, e um **saldo minimo anterior ao POST**, de 0 a 1.000.000 creditos.
- A configuracao e criptografada com safeStorage do Windows, sem expor a identidade ou os valores em logs.
- O limite preserva tentativas reservadas quando a permissao e desativada/reabilitada. Nao reseta automaticamente em reinicializacoes.
- O codigo de reserva opera sob fila serial e grava a reserva antes de uma futura tentativa de POST. **Nao ha POST CPI nesta fase**.
- Erros, corrupcao de arquivo, autorizacao inexistente, limite esgotado ou saldo insuficiente resultam em bloqueio.
- A reserva de cada tentativa tambem exige que a autorizacao geral de consultas esteja ativa; a funcao de reserva recusa explicitamente o estado desautorizado.

## Limites deste controle

A API `GET /credits` fornece o saldo (data.balance), mas o custo de cada combinacao de datasets nao foi determinado como um valor fixo universal. Portanto, **limite de POSTs nao equivale a teto de creditos consumidos**. O saldo minimo e uma verificacao anterior ao POST e nao garante o saldo posterior. O custo devera ser aferido e o mecanismo de gasto autorizado revisado antes de liberar consultas automáticas.

## Estado atual

- CPI: leitura e filtro 29 funcionais conforme teste apresentado pelo usuario.
- Recuperacao GET (Fase 4B): preservada.
- Nova consulta automatica (`POST /queries`): **desabilitada**.
- Upload PDF e salvamento CPI: **desabilitados**.
- GitHub: sem commit e sem push. Branch local de desenvolvimento permanece sob controle do usuario.

## Validacoes exigidas no Windows

1. `npm run typecheck`
2. `npm test`
3. `npm run build`
4. `npm run dev`
5. Autenticar em uma conta, conferir status inicial desativado; salvar limite e reabrir o aplicativo para verificar a persistencia.
6. Autenticar em outra conta e comprovar que os limites nao foram compartilhados.
7. Desativar a autorizacao e verificar que nenhum novo POST CPI passa a ocorrer.

Nao limpar ou zerar automaticamente reservas de POSTs: se uma chamada futura falhar apos o envio, pode ter sido cobrada. A conciliacao exigira auditoria antes de reautorizar tentativas.

/**
 * Consultas CPI não possuem limite local de quantidade. Antes de cada POST novo,
 * valide a autorização da conta e o saldo retornado por GET /credits.
 * Saldo positivo não garante o custo de todos os datasets: a API decide e pode
 * devolver HTTP 403 / 4003. Nunca fazer retry automático desse POST.
 */
export function assertCpiPaidBalance(availableCredits: number, approved: boolean): void {
  if (!approved) throw new Error('Autorize novas consultas Deskdata para esta conta em Minha conta.');
  if (!Number.isSafeInteger(availableCredits) || availableCredits < 0) {
    throw new Error('Saldo Deskdata inválido; consultas automáticas suspensas.');
  }
  if (availableCredits === 0) {
    throw new Error('Saldo Deskdata zerado; automação pausada até haver créditos disponíveis.');
  }
}

/** Intervalos operacionais do monitor de listagens CPI, em segundos. */
export const CPI_MIN_INTERVAL_SECONDS = 30;
export const CPI_MAX_INTERVAL_SECONDS = 86_400;

/** Aceita apenas números inteiros em segundos, sem coerção silenciosa. */
export function parseCpiMonitorIntervalInput(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const seconds = Number(trimmed);
  return Number.isSafeInteger(seconds) && seconds >= CPI_MIN_INTERVAL_SECONDS && seconds <= CPI_MAX_INTERVAL_SECONDS
    ? seconds : null;
}

/** Usa o horário absoluto publicado pelo processo principal; não cria um segundo agendador. */
export function getCpiRemainingSeconds(nextCheckAt: string | null, nowMs: number): number | null {
  if (!nextCheckAt || !Number.isFinite(nowMs)) return null;
  const targetMs = Date.parse(nextCheckAt);
  if (!Number.isFinite(targetMs)) return null;
  return Math.max(0, Math.ceil((targetMs - nowMs) / 1000));
}

export function formatCpiCountdown(seconds: number | null): string {
  if (seconds === null || !Number.isSafeInteger(seconds) || seconds < 0) return '--:--';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainingSeconds = seconds % 60;
  const twoDigits = (number: number): string => String(number).padStart(2, '0');
  return hours > 0
    ? `${twoDigits(hours)}:${twoDigits(minutes)}:${twoDigits(remainingSeconds)}`
    : `${twoDigits(minutes)}:${twoDigits(remainingSeconds)}`;
}

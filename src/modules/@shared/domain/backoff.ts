export function exponentialBackoff(attempts: number): number {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('backoff exige uma tentativa inteira positiva');
  }
  return Math.min(1000 * 2 ** Math.min(attempts - 1, 9), 300_000);
}

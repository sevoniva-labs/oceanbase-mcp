export function timeoutMicros(timeoutMs: number): number {
  return Math.max(1_000, Math.trunc(timeoutMs * 1000));
}

export function oracleTimeoutHint(timeoutMs: number): string {
  return `/*+ query_timeout(${timeoutMicros(timeoutMs)}) */`;
}

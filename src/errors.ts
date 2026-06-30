export interface SerializedError {
  message: string;
  name?: string;
  code?: unknown;
  errno?: unknown;
  sqlState?: unknown;
  sqlMessage?: unknown;
}

export function serializeError(error: unknown): SerializedError {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }

  const record = error as Error & {
    code?: unknown;
    errno?: unknown;
    sqlState?: unknown;
    sqlMessage?: unknown;
  };

  return {
    message: error.message,
    name: error.name,
    code: record.code,
    errno: record.errno,
    sqlState: record.sqlState,
    sqlMessage: record.sqlMessage
  };
}

export function logError(context: string, error: unknown): void {
  const payload = {
    level: "error",
    context,
    error: serializeError(error),
    timestamp: new Date().toISOString()
  };
  console.error(JSON.stringify(payload));
}

export function logAudit(event: string, data: Record<string, unknown>): void {
  const payload = {
    level: "audit",
    event,
    timestamp: new Date().toISOString(),
    ...data
  };
  console.error(JSON.stringify(payload));
}

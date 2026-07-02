import type { ObConfig } from "../config.js";
import type { SqlParam } from "../db.js";
import { isDeniedColumn, isMaskedColumn } from "../policy.js";
import type { GatewayRuntime } from "../runtime.js";
import { SENSITIVE_SAMPLE_PATTERN } from "../sensitive.js";

export const QUERY_SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_QUERY_SESSIONS = 100;

export interface QuerySessionState {
  id: string;
  profile: string;
  mode: ObConfig["compatibility"];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  businessTerm?: string;
  schema?: string;
  table?: string;
  columns: string[];
  sql?: string;
  params: SqlParam[];
  page: number;
  pageSize?: number;
  orderBy?: string;
  warnings: string[];
  masking: {
    maskedColumns: string[];
    sensitiveColumns: string[];
  };
  resultState: {
    rowCount?: number;
    hasMore?: boolean;
    truncated?: boolean;
  };
}

type RuntimeWithQuerySessions = GatewayRuntime & {
  querySessions?: Map<string, QuerySessionState>;
};

export function ensureQuerySessionStore(runtime: GatewayRuntime): Map<string, QuerySessionState> {
  const shared = runtime as RuntimeWithQuerySessions;
  if (!shared.querySessions) {
    shared.querySessions = new Map();
  }
  return shared.querySessions;
}

export function cleanupQuerySessions(store: Map<string, QuerySessionState>) {
  const now = Date.now();
  for (const [id, session] of store.entries()) {
    if (Date.parse(session.expiresAt) <= now) {
      store.delete(id);
    }
  }
}

export function pruneQuerySessions(store: Map<string, QuerySessionState>) {
  if (store.size <= MAX_QUERY_SESSIONS) {
    return;
  }
  const sessions = [...store.values()].sort((left, right) =>
    Date.parse(left.updatedAt) - Date.parse(right.updatedAt)
  );
  for (const session of sessions.slice(0, store.size - MAX_QUERY_SESSIONS)) {
    store.delete(session.id);
  }
}

export function getQuerySessionForProfile(
  store: Map<string, QuerySessionState>,
  sessionId: string,
  profile: string
): QuerySessionState {
  const session = store.get(sessionId);
  if (!session) {
    throw new Error(`Query session "${sessionId}" was not found or has expired.`);
  }
  if (session.profile !== profile) {
    throw new Error(`Query session "${sessionId}" does not belong to profile "${profile}".`);
  }
  return session;
}

export function validateQuerySessionColumns(
  columns: string[],
  schema: string | undefined,
  table: string | undefined,
  config: ObConfig,
  assertTable?: (schema: string | undefined, table: string) => void
): string[] {
  const output = uniqueStrings(columns.map((column) => column.trim()).filter(Boolean));
  for (const column of output) {
    if (isDeniedColumn(column, config.policy)) {
      throw new Error(`Column "${column}" is blocked by OB_DENIED_COLUMNS.`);
    }
  }
  if (table) {
    assertTable?.(schema, table);
  }
  return output;
}

export function querySessionMasking(
  columns: string[],
  schema: string | undefined,
  table: string | undefined,
  config: ObConfig
) {
  const maskedColumns = columns.filter((column) => isMaskedColumn(column, config.policy, schema, table));
  const sensitiveColumns = columns.filter((column) => SENSITIVE_SAMPLE_PATTERN.test(column));
  return {
    maskedColumns: uniqueStrings(maskedColumns),
    sensitiveColumns: uniqueStrings(sensitiveColumns)
  };
}

export function publicQuerySession(session: QuerySessionState) {
  return {
    sessionId: session.id,
    profile: session.profile,
    mode: session.mode,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    businessTerm: session.businessTerm ?? null,
    schema: session.schema ?? null,
    table: session.table ?? null,
    columns: session.columns,
    sql: session.sql ?? null,
    paramCount: session.params.length,
    page: session.page,
    pageSize: session.pageSize ?? null,
    orderBy: session.orderBy ?? null,
    warnings: session.warnings,
    masking: session.masking,
    resultState: session.resultState
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

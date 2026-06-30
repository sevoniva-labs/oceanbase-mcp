import type { AccessPolicy, CompatibilityMode } from "./config.js";
import type { QueryOutput } from "./format.js";

export interface TableRef {
  schema?: string;
  table: string;
  raw: string;
}

export interface PolicyContext {
  compatibility: CompatibilityMode;
  defaultSchema?: string;
  policy: AccessPolicy;
}

export interface PolicyExplanationCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface PolicyExplanation {
  allowed: boolean;
  tableRefs: TableRef[];
  checks: PolicyExplanationCheck[];
}

const IDENTIFIER_SOURCE = String.raw`(?:` + "`[^`]+`" + String.raw`|"(?:""|[^"])+"|[A-Za-z_][\w$]*)`;
const QUALIFIED_NAME_SOURCE = String.raw`(?:` + IDENTIFIER_SOURCE + String.raw`\s*\.\s*)?` + IDENTIFIER_SOURCE;
const TABLE_REF_PATTERN = new RegExp(
  String.raw`\b(?:from|join|describe|desc|table)\s+\(*\s*(` + QUALIFIED_NAME_SOURCE + String.raw`)`,
  "gi"
);
const IDENTIFIER_PATTERN = new RegExp(IDENTIFIER_SOURCE, "g");

export function assertSqlPolicy(sql: string, context: PolicyContext): void {
  const code = codeOnly(sql);
  assertSelectStarPolicy(code, context.policy);
  assertDeniedColumnNames(code, context.policy);

  const refs = extractTableRefs(code);
  for (const ref of refs) {
    assertTableRefAllowed(ref, context);
  }
}

export function explainSqlPolicy(sql: string, context: PolicyContext): PolicyExplanation {
  const code = codeOnly(sql);
  const checks: PolicyExplanationCheck[] = [];
  const tableRefs = extractTableRefs(code);

  checks.push(runCheck("select_star", () => assertSelectStarPolicy(code, context.policy)));
  checks.push(runCheck("denied_columns", () => assertDeniedColumnNames(code, context.policy)));
  for (const ref of tableRefs) {
    checks.push(runCheck(`table_ref:${ref.raw}`, () => assertTableRefAllowed(ref, context)));
  }
  if (tableRefs.length === 0) {
    checks.push({
      name: "table_refs",
      ok: true,
      message: "No direct table references were extracted."
    });
  }

  return {
    allowed: checks.every((check) => check.ok),
    tableRefs,
    checks
  };
}

export function assertTableAccess(schema: string | undefined, table: string, context: PolicyContext): void {
  assertTableRefAllowed({ schema, table, raw: schema ? `${schema}.${table}` : table }, context);
}

export function filterSchemas(rows: unknown[], policy: AccessPolicy): unknown[] {
  return rows.filter((row) => {
    const record = row as Record<string, unknown>;
    const schema = stringValue(record.Database ?? record.schema_name ?? record.SCHEMA_NAME ?? record.username ?? record.USERNAME);
    if (!schema) {
      return true;
    }
    return isSchemaAllowed(schema, policy);
  });
}

export function filterTables(rows: unknown[], policy: AccessPolicy): unknown[] {
  return rows.filter((row) => {
    const record = row as Record<string, unknown>;
    const schema = stringValue(
      record.table_schema ??
        record.TABLE_SCHEMA ??
        record.table_owner ??
        record.TABLE_OWNER ??
        record.owner ??
        record.OWNER ??
        record.schema_name ??
        record.SCHEMA_NAME
    );
    const table = stringValue(record.table_name ?? record.TABLE_NAME);
    if (!table) {
      return true;
    }
    return isTableAllowed({ schema, table, raw: schema ? `${schema}.${table}` : table }, { policy });
  });
}

export function filterColumnMetadata(rows: unknown[], policy: AccessPolicy): unknown[] {
  return filterTables(rows, policy).filter((row) => {
    const record = row as Record<string, unknown>;
    const column = stringValue(record.column_name ?? record.COLUMN_NAME);
    return !column || !isDeniedColumn(column, policy);
  });
}

export function assertOutputAllowed(output: QueryOutput, policy: AccessPolicy): void {
  const deniedField = output.fields?.find((field) => isDeniedColumn(field.name, policy));
  if (deniedField) {
    throw new Error(`Result field "${deniedField.name}" is blocked by OB_DENIED_COLUMNS.`);
  }
}

export function isSchemaAllowed(schema: string, policy: AccessPolicy): boolean {
  const normalized = normalizeName(schema);
  if (!policy.includeSystemSchemas && policy.deniedSchemas.some((pattern) => matchesPattern(normalized, pattern))) {
    return false;
  }
  if (policy.deniedSchemas.some((pattern) => matchesPattern(normalized, pattern))) {
    return false;
  }
  if (policy.allowedSchemas.length > 0) {
    return policy.allowedSchemas.some((pattern) => matchesPattern(normalized, pattern));
  }
  return true;
}

function assertTableRefAllowed(ref: TableRef, context: PolicyContext): void {
  if (!isTableAllowed(resolveRef(ref, context), context)) {
    throw new Error(`Table reference "${ref.raw}" is not allowed by the configured OceanBase MCP access policy.`);
  }
}

function isTableAllowed(ref: TableRef, context: Pick<PolicyContext, "policy">): boolean {
  const schema = ref.schema ? normalizeName(ref.schema) : undefined;
  const table = normalizeName(ref.table);
  const fullName = schema ? `${schema}.${table}` : table;

  if (schema && !isSchemaAllowed(schema, context.policy)) {
    return false;
  }

  if (context.policy.deniedTables.some((pattern) => matchesPattern(fullName, pattern) || matchesPattern(table, pattern))) {
    return false;
  }

  if (context.policy.allowedTables.length > 0) {
    return context.policy.allowedTables.some((pattern) => matchesPattern(fullName, pattern) || matchesPattern(table, pattern));
  }

  if (context.policy.allowedSchemas.length > 0) {
    return schema != null && context.policy.allowedSchemas.some((pattern) => matchesPattern(schema, pattern));
  }

  return true;
}

function resolveRef(ref: TableRef, context: PolicyContext): TableRef {
  if (ref.schema) {
    return ref;
  }

  if (context.defaultSchema) {
    return { ...ref, schema: context.defaultSchema };
  }

  if (context.policy.allowedSchemas.length === 1) {
    return { ...ref, schema: context.policy.allowedSchemas[0] };
  }

  if (context.policy.allowedSchemas.length > 1 || context.policy.allowedTables.some((pattern) => pattern.includes("."))) {
    throw new Error(
      `Unqualified table reference "${ref.raw}" is not allowed. Qualify it with a schema or configure OB_DATABASE.`
    );
  }

  return ref;
}

function assertSelectStarPolicy(code: string, policy: AccessPolicy): void {
  if (policy.allowSelectStar) {
    return;
  }

  const selectModifier = String.raw`(?:all|distinct|distinctrow|unique|high_priority|straight_join|sql_small_result|sql_big_result|sql_buffer_result|sql_no_cache|sql_calc_found_rows)`;
  const qualifiedStar = String.raw`(?:` + IDENTIFIER_SOURCE + String.raw`\s*\.\s*)?\*`;
  const directSelectStar = new RegExp(String.raw`\bselect\s+(?:` + selectModifier + String.raw`\s+)*` + qualifiedStar, "i");
  const commaSelectStar = new RegExp(String.raw`(?:^|,)\s*` + qualifiedStar, "i");

  if (directSelectStar.test(code) || commaSelectStar.test(code)) {
    throw new Error("SELECT * is blocked. List explicit columns or set OB_ALLOW_SELECT_STAR=true after review.");
  }
}

function assertDeniedColumnNames(code: string, policy: AccessPolicy): void {
  const identifiers = [...code.matchAll(IDENTIFIER_PATTERN)].map((match) => normalizeName(match[0])).filter(Boolean);

  for (const column of policy.deniedColumns) {
    const normalized = normalizeName(column);
    if (!normalized) {
      continue;
    }
    if (identifiers.some((identifier) => matchesPattern(identifier, normalized))) {
      throw new Error(`Column or identifier "${column}" is blocked by OB_DENIED_COLUMNS.`);
    }
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|[^A-Za-z0-9_$])${escaped}(?:$|[^A-Za-z0-9_$])`, "i");
    if (pattern.test(code)) {
      throw new Error(`Column or identifier "${column}" is blocked by OB_DENIED_COLUMNS.`);
    }
  }
}

export function isDeniedColumn(column: string, policy: AccessPolicy): boolean {
  const normalized = normalizeName(column);
  return policy.deniedColumns.some((pattern) => matchesPattern(normalized, pattern));
}

function runCheck(name: string, check: () => void): PolicyExplanationCheck {
  try {
    check();
    return { name, ok: true, message: "Allowed." };
  } catch (error) {
    return { name, ok: false, message: (error as Error).message };
  }
}

function extractTableRefs(code: string): TableRef[] {
  const refs: TableRef[] = [];
  for (const match of code.matchAll(TABLE_REF_PATTERN)) {
    const raw = match[1]?.replace(/\s+/g, "");
    if (!raw) {
      continue;
    }
    const parts = splitQualifiedName(raw);
    if (parts.length === 1 && parts[0] === "select") {
      continue;
    }
    if (parts.length === 1) {
      refs.push({ table: parts[0], raw });
    } else if (parts.length === 2) {
      refs.push({ schema: parts[0], table: parts[1], raw });
    }
  }

  for (const ref of extractCommaJoinRefs(code)) {
    if (!refs.some((existing) => existing.raw === ref.raw)) {
      refs.push(ref);
    }
  }

  return refs;
}

function extractCommaJoinRefs(code: string): TableRef[] {
  const refs: TableRef[] = [];
  const fromClausePattern = /\bfrom\s+([\s\S]*?)(?=\bwhere\b|\bgroup\s+by\b|\border\s+by\b|\bhaving\b|\blimit\b|\bfetch\b|\bunion\b|$)/gi;

  for (const match of code.matchAll(fromClausePattern)) {
    const clause = match[1] ?? "";
    for (const segment of splitTopLevelComma(clause)) {
      const trimmed = segment.trim();
      if (!trimmed) {
        continue;
      }

      const token = firstTableFactor(trimmed);
      if (!token || token.toLowerCase() === "select") {
        continue;
      }

      const parts = splitQualifiedName(token);
      if (parts.length === 1) {
        refs.push({ table: parts[0], raw: token });
      } else if (parts.length === 2) {
        refs.push({ schema: parts[0], table: parts[1], raw: token });
      }
    }
  }

  return refs;
}

function splitTopLevelComma(value: string): string[] {
  const segments: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | undefined;

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      current += char;
      if (char === quote) {
        quote = undefined;
      } else if (char === "\\") {
        i += 1;
        current += value[i] ?? "";
      }
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (char === "," && depth === 0) {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  segments.push(current);
  return segments;
}

function firstTableFactor(value: string): string | undefined {
  if (/^\(+\s*select\b/i.test(value)) {
    return undefined;
  }

  const parenthesized = new RegExp(String.raw`^\(+\s*(` + QUALIFIED_NAME_SOURCE + String.raw`)\s*\)+`, "i").exec(value);
  if (parenthesized?.[1] && normalizeName(parenthesized[1]) !== "select") {
    return parenthesized[1].replace(/\s+/g, "");
  }

  return value.split(/\s+/)[0];
}

function splitQualifiedName(value: string): string[] {
  return value
    .split(".")
    .map((part) => normalizeName(part))
    .filter(Boolean);
}

function matchesPattern(value: string, pattern: string): boolean {
  const normalizedPattern = normalizeName(pattern);
  if (normalizedPattern === "*") {
    return true;
  }
  if (!normalizedPattern.includes("*")) {
    return value === normalizedPattern;
  }

  const regex = new RegExp(
    `^${normalizedPattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
    "i"
  );
  return regex.test(value);
}

function normalizeName(value: string): string {
  return value.trim().replace(/^`|`$/g, "").replace(/^"|"$/g, "").toLowerCase();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function codeOnly(sql: string): string {
  let state: "code" | "single" | "doubleIdentifier" | "backtick" | "line" | "block" = "code";
  let output = "";

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];

    if (state === "code") {
      if (char === "'") {
        state = "single";
        output += " ";
      } else if (char === '"') {
        state = "doubleIdentifier";
        output += char;
      } else if (char === "`") {
        state = "backtick";
        output += char;
      } else if (char === "-" && next === "-") {
        state = "line";
        output += "  ";
        i += 1;
      } else if (char === "#") {
        state = "line";
        output += " ";
      } else if (char === "/" && next === "*") {
        state = "block";
        output += "  ";
        i += 1;
      } else {
        output += char;
      }
      continue;
    }

    if (state === "line") {
      output += char === "\n" || char === "\r" ? char : " ";
      if (char === "\n" || char === "\r") {
        state = "code";
      }
      continue;
    }

    if (state === "block") {
      output += " ";
      if (char === "*" && next === "/") {
        output += " ";
        i += 1;
        state = "code";
      }
      continue;
    }

    if (state === "backtick" || state === "doubleIdentifier") {
      output += char;
      if ((state === "backtick" && char === "`") || (state === "doubleIdentifier" && char === '"')) {
        if (state === "doubleIdentifier" && next === '"') {
          output += next;
          i += 1;
          continue;
        }
        state = "code";
      }
      continue;
    }

    output += char === "\n" || char === "\r" ? char : " ";
    if (char === "\\") {
      output += " ";
      i += 1;
      continue;
    }
    if (state === "single" && char === "'") {
      if (next === "'") {
        output += " ";
        i += 1;
      } else {
        state = "code";
      }
    }
  }

  return output;
}

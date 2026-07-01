import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type InitMode = "mysql" | "oracle";

export interface InitOptions {
  cwd?: string;
  mode?: InitMode;
  host?: string;
  port?: string;
  schema?: string;
  username?: string;
  tenant?: string;
  cluster?: string;
  force?: boolean;
  dryRun?: boolean;
}

export interface InitFile {
  path: string;
  content: string;
}

export interface InitPlan {
  root: string;
  mode: InitMode;
  files: InitFile[];
}

const DEFAULT_CLUSTER = "obcluster";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = "2883";
const DEFAULT_USERNAME = "ob_user";

export async function runInitCommand(args: string[], cwd = process.cwd()): Promise<number> {
  try {
    const options = parseInitArgs(args);
    const plan = createInitPlan({ ...options, cwd });
    if (options.dryRun) {
      console.log(JSON.stringify({
        ok: true,
        mode: plan.mode,
        root: plan.root,
        files: plan.files.map((file) => file.path)
      }, null, 2));
      return 0;
    }
    const written = writeInitFiles(plan, { force: options.force === true });
    console.log(JSON.stringify({
      ok: true,
      message: "OceanBase MCP local files created.",
      files: written
    }, null, 2));
    return 0;
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: (error as Error).message
    }, null, 2));
    return 1;
  }
}

export function parseInitArgs(args: string[]): InitOptions {
  const options: InitOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const [name, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    if (!name.startsWith("--")) {
      throw new Error(`Unknown init argument: ${arg}`);
    }
    const value = inlineValue ?? args[index + 1];
    if (inlineValue == null) {
      index += 1;
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${name}`);
    }
    switch (name) {
      case "--mode":
        options.mode = parseMode(value);
        break;
      case "--host":
        options.host = value;
        break;
      case "--port":
        options.port = value;
        break;
      case "--schema":
        options.schema = value;
        break;
      case "--username":
        options.username = value;
        break;
      case "--tenant":
        options.tenant = value;
        break;
      case "--cluster":
        options.cluster = value;
        break;
      default:
        throw new Error(`Unknown init argument: ${name}`);
    }
  }
  return options;
}

export function createInitPlan(options: InitOptions = {}): InitPlan {
  const root = resolve(options.cwd ?? process.cwd());
  const mode = options.mode ?? "mysql";
  const username = options.username ?? DEFAULT_USERNAME;
  const tenant = options.tenant ?? defaultTenant(mode);
  const cluster = options.cluster ?? DEFAULT_CLUSTER;
  const schema = options.schema ?? defaultSchema(mode, username);
  const user = `${username}@${tenant}${cluster ? `#${cluster}` : ""}`;
  const command = detectSourceCheckout(root) ? ["node", "dist/index.js"] : ["ob-mcp"];

  return {
    root,
    mode,
    files: [
      {
        path: join(root, ".env"),
        content: renderEnv({
          host: options.host ?? DEFAULT_HOST,
          port: options.port ?? DEFAULT_PORT,
          user,
          mode,
          schema
        })
      },
      {
        path: join(root, "opencode.jsonc"),
        content: renderOpenCodeConfig({
          command,
          host: options.host ?? DEFAULT_HOST,
          port: options.port ?? DEFAULT_PORT,
          user,
          mode,
          schema
        })
      },
      {
        path: join(root, ".opencode", "agents", "oceanbase-developer.md"),
        content: renderAgent()
      },
      {
        path: join(root, ".opencode", "skills", "oceanbase-query", "SKILL.md"),
        content: renderSkill()
      },
      {
        path: join(root, "business-glossary.json"),
        content: renderBusinessGlossary(schema)
      }
    ]
  };
}

export function writeInitFiles(plan: InitPlan, options: { force?: boolean } = {}): string[] {
  const written: string[] = [];
  for (const file of plan.files) {
    if (!options.force && existsSync(file.path)) {
      throw new Error(`${file.path} already exists. Re-run with --force to overwrite generated files.`);
    }
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content);
    written.push(file.path);
  }
  return written;
}

function parseMode(value: string): InitMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "mysql" || normalized === "oracle") {
    return normalized;
  }
  throw new Error("--mode must be mysql or oracle.");
}

function defaultTenant(mode: InitMode): string {
  return mode === "oracle" ? "ob_oracle" : "ob_mysql";
}

function defaultSchema(mode: InitMode, username: string): string {
  return mode === "oracle" ? username.toUpperCase() : "biz_test";
}

function detectSourceCheckout(root: string): boolean {
  try {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string };
    return packageJson.name === "ob-mcp" && existsSync(join(root, "src", "index.ts"));
  } catch {
    return false;
  }
}

function renderEnv(input: { host: string; port: string; user: string; mode: InitMode; schema: string }): string {
  return `# OceanBase MCP 本地开发配置
# 请先修改 OB_USER、OB_PASSWORD 和 OB_ALLOWED_SCHEMAS。
OB_HOST=${input.host}
OB_PORT=${input.port}
OB_USER=${input.user}
OB_PASSWORD=change-me
OB_COMPATIBILITY=${input.mode}
OB_ALLOWED_SCHEMAS=${input.schema}

# MCP 永远只读。不要改成 false。
OB_MCP_READ_ONLY=true
OB_ALLOW_SELECT_STAR=false
OB_ENFORCE_READ_ONLY_TX=true

# 查询和输出限制
OB_MAX_ROWS=100
OB_MAX_RESULT_BYTES=1048576
OB_MAX_SQL_LENGTH=20000
OB_MAX_PARAM_COUNT=500
OB_MAX_CONCURRENT_QUERIES=5

# 样例值脱敏规则，支持 schema.table.column、table.column、column 和 * 通配。
# OB_MASKED_COLUMNS=${input.schema}.users.email,*.orders.phone,access_token

# 业务字典只用于搜索提示，不授予额外访问权限。
OB_BUSINESS_GLOSSARY_FILE=business-glossary.json
`;
}

function renderOpenCodeConfig(input: {
  command: string[];
  host: string;
  port: string;
  user: string;
  mode: InitMode;
  schema: string;
}): string {
  return `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    mcp: {
      oceanbase: {
        type: "local",
        command: input.command,
        enabled: true,
        environment: {
          OB_HOST: input.host,
          OB_PORT: input.port,
          OB_USER: input.user,
          OB_PASSWORD: "change-me",
          OB_COMPATIBILITY: input.mode,
          OB_ALLOWED_SCHEMAS: input.schema,
          OB_MAX_ROWS: "100",
          OB_ALLOW_SELECT_STAR: "false",
          OB_BUSINESS_GLOSSARY_FILE: "business-glossary.json"
        }
      }
    }
  }, null, 2)}
`;
}

function renderAgent(): string {
  return `---
name: oceanbase-developer
description: Uses OceanBase MCP for metadata-first OceanBase development, read-only SQL, paged querying, ER diagrams, and data documentation.
---

Use this agent for OceanBase development tasks that need database metadata, read-only SQL, query previews, paged result lookup, ER diagrams, or data documentation.

Rules:

1. Search metadata before writing SQL.
2. Do not guess table names, column names, or relationships.
3. Read table context, schema map, or onboarding documentation before choosing columns or joins.
4. Use ob_prepare_query or ob_build_select for SQL assistance.
5. Preview or lint SQL before execution.
6. Use query sessions and paged queries for data inspection.
7. Use ob_generate_er_html, data dictionary, and documentation tools for structure questions.
8. Report masking, truncation, unstable ordering, and assumptions clearly.

Never run or suggest write SQL, DDL, DCL, procedure calls, sequence NEXTVAL, locks, file functions, sleep functions, or multi-statement SQL.
`;
}

function renderSkill(): string {
  return `---
name: oceanbase-query
description: Guide OpenCode to use OceanBase MCP for metadata-first OceanBase querying, SQL assistance, ER diagrams, and result documentation.
license: MIT
compatibility: opencode
metadata:
  mcp: oceanbase
  safety: read-only
---

## Workflow

1. Search metadata and business glossary first.
2. Read table context, schema map, or onboarding documentation before SQL.
3. Use ob_prepare_query or ob_build_select to create explicit-column SELECT SQL.
4. Use ob_lint_sql or ob_query_preview before execution.
5. Query with a session and pagination.
6. Summarize SQL, rows, page state, warnings, masking, and assumptions.

## Tool Preference

- Use ob_search_everything, ob_get_schema_map, ob_find_tables_by_business_term, ob_find_columns, and ob_get_table_context before SQL.
- Use ob_prepare_query, ob_build_select, ob_lint_sql, and ob_query_preview for SQL assistance.
- Use ob_start_query_session, ob_query_page, ob_query_next_page, and ob_query_prev_page for data lookup.
- Use ER HTML, entity diagrams, relationship explanation, data dictionary, table/schema/query docs, and onboarding docs for structure questions.
- Use ob_get_cache_status or ob_refresh_metadata_cache only when metadata appears stale.
- Use Oracle-compatible syntax when the profile is Oracle mode.

Do not invent tables, fields, joins, or relationships. If metadata is insufficient, ask for a business term, schema, or table name.
`;
}

function renderBusinessGlossary(schema: string): string {
  return `${JSON.stringify({
    terms: [
      {
        term: "订单",
        aliases: ["order", "sales order"],
        description: "订单主表和订单明细。",
        targets: [
          { schema, table: "orders" },
          { schema, table: "order_items" }
        ]
      },
      {
        term: "用户",
        aliases: ["user", "account"],
        description: "用户账号和基础资料。",
        targets: [
          { schema, table: "users" },
          { schema, table: "accounts" }
        ]
      },
      {
        term: "支付",
        aliases: ["payment", "transaction"],
        description: "支付单和交易流水。",
        targets: [
          { schema, table: "payments" },
          { schema, table: "transactions" }
        ]
      }
    ]
  }, null, 2)}
`;
}

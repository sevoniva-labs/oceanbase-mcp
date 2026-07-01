# 安全基线

[English](../en/security.md) | [返回](README.md)

## 边界

OceanBase MCP 是 MCP client 与 OceanBase 之间的只读网关。它保护数据查看流程；它不是数据库防火墙，也不替代 OceanBase 账号权限。

建议两层同时使用：

- MCP 层：无写工具、SQL guard、策略检查、行数/返回大小限制、并发限制、输出过滤。
- 数据库层：尽可能使用只有 SELECT/元数据权限的最小权限账号。

## 控制项

| 控制项 | 状态 |
| --- | --- |
| 无写工具 | 始终强制。 |
| 不可变只读模式 | `OB_MCP_READ_ONLY=false` 会被拒绝。 |
| SQL 起始关键字 allowlist | 只允许 `SELECT`、`WITH` 和只读 `EXPLAIN`。 |
| 多语句拦截 | 启用。 |
| `SELECT *` 拦截 | 默认启用。 |
| 系统 schema 拒绝 | 默认启用。 |
| 敏感列拒绝 | 默认启用。 |
| 字段级样例脱敏 | `OB_MASKED_COLUMNS` 支持精确列和通配规则。 |
| 开发辅助工具 | DDL、ER、SQL 模板、性能报告等工具只读取元数据或执行只读 `EXPLAIN`。 |
| 只读事务 | 默认启用。 |
| 行数和返回大小上限 | 默认启用，且客户端不能放大。 |
| 并发上限 | 每个 profile 默认启用。 |
| HTTP Bearer token | 生产 HTTP 和非本地绑定必填，支持按 profile/tool 限制。 |
| Host allowlist | 非本地绑定必填。 |
| 来源 IP allowlist | 非本地绑定必填。 |
| `/metrics` 鉴权 | 生产和非本地绑定默认启用。 |
| 限流和 body 限制 | 默认启用。 |
| secret 文件加载 | 支持数据库密码和 Bearer token。 |
| 数据库账号权限核验 | `ob_verify_permissions` 读取 grants/session privileges。 |

## 来源 IP Allowlist

支持精确 IP 和 CIDR：

```bash
OB_MCP_ALLOWED_IPS=203.0.113.10,10.0.0.0/8,2001:db8::/32
```

部署在可信代理之后：

```bash
OB_MCP_TRUST_PROXY=1
```

只有 MCP 服务不能被不可信客户端绕过代理直接访问时，才启用 proxy trust。`true` 表示信任所有代理转发头，优先使用跳数或明确代理 CIDR。

## 生产建议

- MCP HTTP 绑定 `127.0.0.1`，前面使用 Nginx、Ingress 或负载均衡。
- 边缘入口启用 TLS。
- 使用 `OB_MCP_AUTH_TOKEN_FILE`，不要内联 token。
- 使用 `OB_PASSWORD_FILE`，不要内联数据库密码。
- 设置 `OB_ALLOWED_SCHEMAS` 或 schema-qualified `OB_ALLOWED_TABLES`。
- 按需设置 `OB_MASKED_COLUMNS`，对样例输出做字段级脱敏。
- 保持 `OB_ALLOW_SELECT_STAR=false`。
- 保持 `OB_ENFORCE_READ_ONLY_TX=true`。
- 设置 `OB_MAX_ROWS`、`OB_MAX_RESULT_BYTES` 和 `OB_MAX_CONCURRENT_QUERIES`。
- 尽可能使用只有 SELECT/元数据权限的数据库账号。
- 用 `ob_verify_permissions` 核验账号权限。
- 采集 JSON 日志并抓取 `/metrics`。

## 明确不支持

- 写 SQL 执行。
- schema 变更。
- 存储过程调用。
- 输出可直接执行的 DDL 或索引变更建议。
- 文件导入/导出函数。
- 通过 `ob_query` 执行 `SHOW` 和 `DESCRIBE`；请使用元数据工具。
- 关闭 MCP 只读模式。

## 验证

```bash
npm test
npm run mcp:smoke
npm run http:smoke
npm audit --omit=dev --audit-level=moderate
```

HTTP smoke 会验证未认证请求返回 `401`，不允许的来源 IP 返回 `403`。

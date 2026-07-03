# OceanBase MCP v1.5.0

v1.5.0 refreshes the public documentation and release wording. It does not change the database read-only boundary or add write, DDL, DCL, procedure execution, or sequence `NEXTVAL` capability.

## Changes

- Reworked the root README into a concise public entry point.
- Split the complete MCP tool list into dedicated English and Chinese tool documents.
- Kept the tool list sorted by first supported version.
- Updated installation, OpenCode, source-build, release-asset, and deployment wording for public distribution.
- Replaced internal-facing distribution wording with neutral npm registry mirror wording.
- Added documentation checks for public wording and tool-table order.
- Updated package, server, Docker Compose, Kubernetes, README, OpenCode, and deployment examples to v1.5.0.

## Distribution

```bash
npm install -g @sevoniva/oceanbase-mcp@1.5.0
ob-mcp --help
npx --registry=https://registry.npmjs.org/ --yes --package=@sevoniva/oceanbase-mcp@1.5.0 ob-mcp --help
```

## Release Assets

- `sevoniva-oceanbase-mcp-1.5.0.tgz`
- `oceanbase-mcp-1.5.0-source.tar.gz`
- `sbom.cdx.json`
- `oceanbase-mcp-1.5.0-amd64.tar.gz`
- `oceanbase-mcp-1.5.0-arm64.tar.gz`
- `ghcr.io/sevoniva/oceanbase-mcp:v1.5.0`
- `ghcr.io/sevoniva/oceanbase-mcp:1.5.0`

## Source Build

```bash
tar -xzf oceanbase-mcp-1.5.0-source.tar.gz
cd oceanbase-mcp-1.5.0
npm ci
npm run build
npm run start
```

The source archive excludes `node_modules` and `dist`. Your npm registry mirror must provide the dependencies locked by `package-lock.json`.

## Validation

- `npm test`: passed.
- `npm run docs:check`: passed.
- `npm audit --omit=dev --audit-level=moderate`: passed.
- `npm pack --dry-run`: passed for `sevoniva-oceanbase-mcp-1.5.0.tgz`.
- Docker build: passed for `oceanbase-mcp:1.5.0`.
- npmjs install and `npx --package=@sevoniva/oceanbase-mcp@1.5.0 ob-mcp --help`: verified after publish.

## Production Notes

- Use a SELECT-only database account where possible; the MCP layer still enforces read-only behavior if the configured account has broader grants.
- Keep HTTP mode behind bearer-token authentication, Host allowlists, source IP allowlists, and TLS or a trusted reverse proxy.
- For large schemas, run `ob_plan_er_export` first and use CLI cluster export instead of inline ER HTML.
- Review inferred ER relationships with their confidence and evidence.

---

# OceanBase MCP v1.5.0

v1.5.0 重整公开文档和发布文案。本版本不改变数据库只读边界，也不增加写入、DDL、DCL、过程执行或序列 `NEXTVAL` 能力。

## 变更

- 将根 README 重整为简洁的公开入口。
- 将完整 MCP 工具列表拆分为独立的中英文工具文档。
- 工具列表继续按首次支持版本排序。
- 更新安装、OpenCode、源码构建、Release 资产和部署说明。
- 将偏内部场景的分发措辞替换为中性的 npm registry 镜像表述。
- 增加公开文档措辞和工具表排序检查。
- package、server、Docker Compose、Kubernetes、README、OpenCode 和部署示例更新到 v1.5.0。

## 分发

```bash
npm install -g @sevoniva/oceanbase-mcp@1.5.0
ob-mcp --help
npx --registry=https://registry.npmjs.org/ --yes --package=@sevoniva/oceanbase-mcp@1.5.0 ob-mcp --help
```

## Release 资产

- `sevoniva-oceanbase-mcp-1.5.0.tgz`
- `oceanbase-mcp-1.5.0-source.tar.gz`
- `sbom.cdx.json`
- `oceanbase-mcp-1.5.0-amd64.tar.gz`
- `oceanbase-mcp-1.5.0-arm64.tar.gz`
- `ghcr.io/sevoniva/oceanbase-mcp:v1.5.0`
- `ghcr.io/sevoniva/oceanbase-mcp:1.5.0`

## 源码构建

```bash
tar -xzf oceanbase-mcp-1.5.0-source.tar.gz
cd oceanbase-mcp-1.5.0
npm ci
npm run build
npm run start
```

源码归档不包含 `node_modules` 和 `dist`。npm registry 镜像需要能提供 `package-lock.json` 中锁定的依赖。

## 验证

- `npm test`：通过。
- `npm run docs:check`：通过。
- `npm audit --omit=dev --audit-level=moderate`：通过。
- `npm pack --dry-run`：通过，包名为 `sevoniva-oceanbase-mcp-1.5.0.tgz`。
- Docker build：通过，镜像为 `oceanbase-mcp:1.5.0`。
- 发布后已验证 npmjs 安装和 `npx --package=@sevoniva/oceanbase-mcp@1.5.0 ob-mcp --help`。

## 生产注意事项

- 尽量使用只有 SELECT 和元数据查看权限的数据库账号；即使账号权限更大，MCP 层仍会保持只读。
- HTTP 模式应配置 bearer token、Host allowlist、来源 IP allowlist，并放在 TLS 或可信反向代理之后。
- 大 schema 先运行 `ob_plan_er_export`，再使用 CLI cluster 导出，不建议用 inline ER HTML。
- 推断 ER 关系必须结合 confidence 和 evidence 判断。

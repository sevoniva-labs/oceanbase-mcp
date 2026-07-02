# OceanBase MCP v1.1.4

v1.1.4 is a performance patch for ER generation. It removes duplicate metadata reads from the default foreign-key ER path and avoids rendering large schema-level inline HTML before returning export guidance. The read-only boundary is unchanged.

## Changes

- `ob_generate_er_diagram` and `ob_generate_er_html` now use foreign-key metadata only during default relationship discovery.
- Field, index, and constraint metadata are loaded once for ER entities instead of being loaded again during foreign-key discovery.
- Schema-level `ob_generate_er_html` skips large inline rendering when the selected scope is broad and returns chunked export guidance instead.
- Explicit table scopes are still supported for local CLI chunk rendering.
- ER documentation now states the large-scope inline HTML fallback behavior.

## Validation

- `npm test`: 213 tests passed.
- Targeted ER tests passed.
- Local OceanBase MySQL 220-table ER validation passed: 5 metadata queries and 1,980 loaded columns.
- Local OceanBase Oracle 220-table ER validation passed: 5 metadata queries and 2,254 loaded columns.
- ER relationship output remains capped by configuration to keep large-scope responses bounded.
- MySQL schema-level 50-table inline HTML request returned export guidance without inline rendering.
- Oracle schema-level 50-table inline HTML request returned export guidance without inline rendering.
- MySQL million-row `ob_describe_table` validation passed.
- Oracle million-row `ob_describe_table` validation passed.

## Internal Build

```bash
tar -xzf ob-mcp-1.1.4-source.tar.gz
cd ob-mcp-1.1.4
npm ci
npm run build
npm run start
```

The source archive does not include `node_modules` or `dist`. The internal npm repository must provide the dependencies locked in `package-lock.json`.

## Assets

- `ob-mcp-1.1.4.tgz`
- `ob-mcp-1.1.4-source.tar.gz`
- `sbom.cdx.json`
- `oceanbase-mcp-1.1.4-amd64.tar.gz`
- `oceanbase-mcp-1.1.4-arm64.tar.gz`
- `ghcr.io/sevoniva/oceanbase-mcp:v1.1.4`

## 中文说明

v1.1.4 是 ER 生成性能补丁。它减少默认外键关系路径的重复元数据读取，并避免 schema 级大范围 inline HTML 在返回导出建议前先渲染大内容。只读安全边界不变。

### 变更

- `ob_generate_er_diagram` 和 `ob_generate_er_html` 在默认关系发现阶段只读取外键元数据。
- 字段、索引和约束元数据只在构建 ER 实体时加载一次，不再在外键关系发现阶段重复加载。
- schema 级 `ob_generate_er_html` 范围过大时会跳过 inline 渲染，并返回分片导出建议。
- 显式 table 范围仍支持本地 CLI 分片渲染。
- ER 文档补充大范围 inline HTML 的降级行为。

### 验证

- `npm test`：213 个测试通过。
- ER 定向测试通过。
- 本地 OceanBase MySQL 220 表 ER 验证通过：5 次元数据查询、1,980 个加载字段。
- 本地 OceanBase Oracle 220 表 ER 验证通过：5 次元数据查询、2,254 个加载字段。
- ER 关系输出继续受配置上限约束，避免大范围结果失控。
- MySQL schema 级 50 表 inline HTML 请求返回导出建议，未返回 inline HTML。
- Oracle schema 级 50 表 inline HTML 请求返回导出建议，未返回 inline HTML。
- MySQL 百万行表 `ob_describe_table` 验证通过。
- Oracle 百万行表 `ob_describe_table` 验证通过。

### 内网编译

```bash
tar -xzf ob-mcp-1.1.4-source.tar.gz
cd ob-mcp-1.1.4
npm ci
npm run build
npm run start
```

源码归档不包含 `node_modules` 和 `dist`。内网 npm 制品库需要能提供 `package-lock.json` 中锁定的依赖。

### 交付资产

- `ob-mcp-1.1.4.tgz`
- `ob-mcp-1.1.4-source.tar.gz`
- `sbom.cdx.json`
- `oceanbase-mcp-1.1.4-amd64.tar.gz`
- `oceanbase-mcp-1.1.4-arm64.tar.gz`
- `ghcr.io/sevoniva/oceanbase-mcp:v1.1.4`

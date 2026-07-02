# OceanBase MCP v1.1.1

v1.1.1 is a stability release for large-schema ER generation. It keeps the read-only boundary unchanged and improves ER planning, metadata loading, HTML browsing, and local chunked export.

## 新增与修复

- 大库 ER 默认收敛：默认 `relationshipMode=foreign_key`，命名推断关系需显式启用。
- 批量元数据加载：ER 生成批量读取字段、索引、约束和关系，减少逐表查询放大。
- `ob_plan_er_export`：为大 schema 输出分片计划、chunk 命令、stats 和 warnings，不返回超大 inline HTML。
- CLI 分片导出：`ob-mcp export-er --out-dir` 写出 `index.html`、`overview.html`、`chunks/`、`tables/` 和 `metadata/`。
- ER HTML 浏览器：大图使用多列概览布局、关键字段优先、表筛选计数、schema 概览和选中表定位。
- OpenCode Agent/Skill：大库先规划再分片；默认使用真实 FK/约束关系，不直接生成全库 inline ER。

## 验证结果

- MySQL 模式：本地 OceanBase 220 张复杂表验证通过；ER 生成 220 张表、219 条关系，批量查询 8 次，CLI 分片导出 5 个 chunk。
- Oracle 模式：本地 OceanBase 220 张复杂表验证通过；ER 生成 220 张表、164 条关系，批量查询 8 次，CLI 分片导出 5 个 chunk。
- MySQL stdio smoke、Oracle stdio smoke、MySQL HTTP smoke、Oracle HTTP smoke 通过。
- ER HTML 已用 5、50、220 表样本生成并截图检查，大图默认进入多列概览。

## 内网编译

Release 包含源码归档：

```bash
tar -xzf ob-mcp-1.1.1-source.tar.gz
cd ob-mcp-1.1.1
npm ci
npm run build
npm run start
```

源码归档不包含 `node_modules` 和 `dist`。内网 npm 制品库需要提供 `package-lock.json` 中锁定的依赖。

## 交付资产

- `ob-mcp-1.1.1.tgz`
- `ob-mcp-1.1.1-source.tar.gz`
- `sbom.cdx.json`
- `oceanbase-mcp-1.1.1-amd64.tar.gz`
- `oceanbase-mcp-1.1.1-arm64.tar.gz`
- `ghcr.io/sevoniva/oceanbase-mcp:v1.1.1`

## 生产注意事项

- 数据库账号仍建议使用只读权限；MCP 会继续拦截写入、DDL、DCL、过程调用、序列 `NEXTVAL`、锁和危险函数。
- 大 schema 先运行 `ob_plan_er_export`，再使用 CLI 分片导出。
- `relationshipMode=inferred` 只用于明确的小范围分析，并必须查看 confidence 和 evidence。
- 单个 chunk 仍受 `OB_MAX_RESULT_BYTES` 控制；表多或字段多时调小 `--chunk-size`。
- 默认 `OB_ER_MAX_TABLES=50` 是保守值，本地机器资源足够时再按需调高。

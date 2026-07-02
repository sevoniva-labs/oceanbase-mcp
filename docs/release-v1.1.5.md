# OceanBase MCP v1.1.5

v1.1.5 adds npmjs distribution for OceanBase MCP. The public package name is `oceanbase-mcp`; the CLI commands remain `ob-mcp`, `ob-mcp-http`, and `ob-mcp-doctor`. The read-only boundary is unchanged.

## Changes

- Renamed the npm package from `ob-mcp` to `oceanbase-mcp`.
- Kept CLI command names unchanged for existing OpenCode and shell usage.
- Added an npmjs publish step to the Release workflow. Publishing runs when the repository secret `NPM_TOKEN` is configured.
- Renamed npm and source release assets to `oceanbase-mcp-${version}.tgz` and `oceanbase-mcp-${version}-source.tar.gz`.
- Updated README, deployment, OpenCode, and release documentation for npmjs and private registry distribution.
- Removed public wording that referenced private deployment boundaries directly.

## npmjs Setup

To publish to npmjs:

1. Create an npmjs account.
2. Enable account security and create an automation token for publishing.
3. Add the token to the GitHub repository secret `NPM_TOKEN`.
4. Run the Release workflow or push a version tag.

If `NPM_TOKEN` is not configured, the Release workflow skips npmjs publishing and still creates the GitHub Release assets.

## Install

```bash
npm install -g oceanbase-mcp@1.1.5
ob-mcp --help
```

Private registries can mirror npmjs and install the same pinned package version.

## Offline Source Build

```bash
tar -xzf oceanbase-mcp-1.1.5-source.tar.gz
cd oceanbase-mcp-1.1.5
npm ci
npm run build
npm run start
```

The source archive does not include `node_modules` or `dist`. The private npm registry must provide the dependencies locked in `package-lock.json`.

## Assets

- `oceanbase-mcp-1.1.5.tgz`
- `oceanbase-mcp-1.1.5-source.tar.gz`
- `sbom.cdx.json`
- `oceanbase-mcp-1.1.5-amd64.tar.gz`
- `oceanbase-mcp-1.1.5-arm64.tar.gz`
- `ghcr.io/sevoniva/oceanbase-mcp:v1.1.5`
- `ghcr.io/sevoniva/oceanbase-mcp:1.1.5`

## 中文说明

v1.1.5 增加 npmjs 分发。公开 npm 包名为 `oceanbase-mcp`；CLI 命令继续保持 `ob-mcp`、`ob-mcp-http` 和 `ob-mcp-doctor`。只读安全边界不变。

### 变更

- npm 包名从 `ob-mcp` 改为 `oceanbase-mcp`。
- CLI 命令名保持不变，兼容现有 OpenCode 和命令行使用方式。
- Release workflow 增加 npmjs 发布步骤。仓库配置 `NPM_TOKEN` 后会执行发布。
- npm 包和源码归档资产改为 `oceanbase-mcp-${version}.tgz` 和 `oceanbase-mcp-${version}-source.tar.gz`。
- README、部署文档、OpenCode 文档和 release 文档补充分发说明。
- 清理公开文案中对私有部署边界的直接表述。

### npmjs 设置

发布到 npmjs 需要：

1. 注册 npmjs 账号。
2. 开启账号安全设置，并创建用于发布的 automation token。
3. 将 token 添加到 GitHub 仓库 secret，名称为 `NPM_TOKEN`。
4. 运行 Release workflow 或推送版本 tag。

如果未配置 `NPM_TOKEN`，Release workflow 会跳过 npmjs 发布，并继续创建 GitHub Release 资产。

### 安装

```bash
npm install -g oceanbase-mcp@1.1.5
ob-mcp --help
```

私有制品库可以同步 npmjs，并安装相同的固定版本。

### 离线源码构建

```bash
tar -xzf oceanbase-mcp-1.1.5-source.tar.gz
cd oceanbase-mcp-1.1.5
npm ci
npm run build
npm run start
```

源码归档不包含 `node_modules` 和 `dist`。私有 npm 制品库需要能提供 `package-lock.json` 中锁定的依赖。

### 交付资产

- `oceanbase-mcp-1.1.5.tgz`
- `oceanbase-mcp-1.1.5-source.tar.gz`
- `sbom.cdx.json`
- `oceanbase-mcp-1.1.5-amd64.tar.gz`
- `oceanbase-mcp-1.1.5-arm64.tar.gz`
- `ghcr.io/sevoniva/oceanbase-mcp:v1.1.5`
- `ghcr.io/sevoniva/oceanbase-mcp:1.1.5`

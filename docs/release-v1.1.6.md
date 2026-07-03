# OceanBase MCP v1.1.6

v1.1.6 refines npmjs distribution for OceanBase MCP. The package remains `@sevoniva/oceanbase-mcp`; the CLI commands remain `ob-mcp`, `ob-mcp-http`, and `ob-mcp-doctor`. The read-only boundary is unchanged.

## Changes

- Corrected npmjs startup examples for scoped package installation.
- Declared Apache-2.0 in npm package metadata.
- Updated OpenCode examples to call the `ob-mcp` binary explicitly through `npx --package`.
- Prepared the Release workflow for npm Trusted Publishing.
- Kept manual first-publish support for npmjs and documented the required npmjs package setting.
- Verified public npm install and `npx --package` startup from npmjs.

## npmjs Setup

To enable GitHub Actions publishing through npm Trusted Publishing:

1. Publish the package once manually if the package does not exist yet.
2. Open the package settings on npmjs.
3. Add a GitHub Actions trusted publisher:
   owner `sevoniva`, repository `oceanbase-mcp`, workflow `release.yml`.
4. Leave the environment field empty unless the workflow uses a GitHub environment.
5. Run the Release workflow or push a version tag.

If the same version already exists on npmjs, the Release workflow skips npm publishing and still creates the GitHub Release assets.

## Install

```bash
npm install -g @sevoniva/oceanbase-mcp@1.1.6
ob-mcp --help
npx --registry=https://registry.npmjs.org/ --yes --package=@sevoniva/oceanbase-mcp@1.1.6 ob-mcp --help
```

Registry mirrors can mirror npmjs and install the same pinned package version.

## Offline Source Build

```bash
tar -xzf oceanbase-mcp-1.1.6-source.tar.gz
cd oceanbase-mcp-1.1.6
npm ci
npm run build
npm run start
```

The source archive does not include `node_modules` or `dist`. The npm registry mirror must provide the dependencies locked in `package-lock.json`.

## Assets

- `sevoniva-oceanbase-mcp-1.1.6.tgz`
- `oceanbase-mcp-1.1.6-source.tar.gz`
- `sbom.cdx.json`
- `oceanbase-mcp-1.1.6-amd64.tar.gz`
- `oceanbase-mcp-1.1.6-arm64.tar.gz`
- `ghcr.io/sevoniva/oceanbase-mcp:v1.1.6`
- `ghcr.io/sevoniva/oceanbase-mcp:1.1.6`

## 中文说明

v1.1.6 优化 npmjs 分发。公开 npm 包名保持 `@sevoniva/oceanbase-mcp`；CLI 命令继续保持 `ob-mcp`、`ob-mcp-http` 和 `ob-mcp-doctor`。只读安全边界不变。

### 变更

- 修正 scoped package 的 npmjs 启动示例。
- 在 npm 包元数据中声明 Apache-2.0 许可。
- OpenCode 示例改为通过 `npx --package` 明确调用 `ob-mcp`。
- Release workflow 按 npm Trusted Publishing 方式准备。
- 保留 npmjs 首次手动发布路径，并补充 npmjs 包设置说明。
- 已验证从 npmjs 公开安装和通过 `npx --package` 启动。

### npmjs 设置

通过 npm Trusted Publishing 启用 GitHub Actions 发布：

1. 如果包还不存在，先手动发布一次。
2. 打开 npmjs 上的包设置页面。
3. 添加 GitHub Actions trusted publisher：
   owner 填 `sevoniva`，repository 填 `oceanbase-mcp`，workflow 填 `release.yml`。
4. 如果 workflow 没有使用 GitHub environment，environment 留空。
5. 运行 Release workflow 或推送版本 tag。

如果 npmjs 已存在相同版本，Release workflow 会跳过 npm 发布，并继续创建 GitHub Release 资产。

### 安装

```bash
npm install -g @sevoniva/oceanbase-mcp@1.1.6
ob-mcp --help
npx --registry=https://registry.npmjs.org/ --yes --package=@sevoniva/oceanbase-mcp@1.1.6 ob-mcp --help
```

npm registry 镜像可以同步 npmjs，并安装相同的固定版本。

### 离线源码构建

```bash
tar -xzf oceanbase-mcp-1.1.6-source.tar.gz
cd oceanbase-mcp-1.1.6
npm ci
npm run build
npm run start
```

源码归档不包含 `node_modules` 和 `dist`。私有 npm 制品库需要能提供 `package-lock.json` 中锁定的依赖。

### 交付资产

- `sevoniva-oceanbase-mcp-1.1.6.tgz`
- `oceanbase-mcp-1.1.6-source.tar.gz`
- `sbom.cdx.json`
- `oceanbase-mcp-1.1.6-amd64.tar.gz`
- `oceanbase-mcp-1.1.6-arm64.tar.gz`
- `ghcr.io/sevoniva/oceanbase-mcp:v1.1.6`
- `ghcr.io/sevoniva/oceanbase-mcp:1.1.6`

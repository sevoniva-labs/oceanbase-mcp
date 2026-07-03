# OceanBase MCP v1.4.0

v1.4.0 is a packaging and public-documentation hygiene release. It does not change the read-only database boundary or add new database capabilities.

## Changes

- Trimmed the npm package file list to runtime assets, bilingual documentation, deployment templates, examples, OpenCode files, and CLI build output.
- Excluded historical release-note files and smoke-test scripts from the npm package because they are not needed at runtime.
- Kept GitHub source archives complete for source builds, audits, smoke tests, and release reproduction.
- Updated package, server, Docker Compose, Kubernetes, README, and deployment examples to v1.4.0.

## Validation

- `npm test`: passed locally before release.
- `npm run docs:check`: passed locally before release.
- `npm audit --omit=dev --audit-level=moderate`: passed locally before release.
- `npm pack --dry-run`: passed locally before release.
- Release workflow must publish the npm package through GitHub Actions and attach the source archive, npm tgz, SBOM, and amd64/arm64 offline images.

## Install

```bash
npm install -g @sevoniva/oceanbase-mcp@1.4.0
ob-mcp --help
npx --registry=https://registry.npmjs.org/ --yes --package=@sevoniva/oceanbase-mcp@1.4.0 ob-mcp --help
```

## Assets

- `sevoniva-oceanbase-mcp-1.4.0.tgz`
- `oceanbase-mcp-1.4.0-source.tar.gz`
- `sbom.cdx.json`
- `oceanbase-mcp-1.4.0-amd64.tar.gz`
- `oceanbase-mcp-1.4.0-arm64.tar.gz`
- `ghcr.io/sevoniva/oceanbase-mcp:v1.4.0`
- `ghcr.io/sevoniva/oceanbase-mcp:1.4.0`

## Notes

- Use the npm package for normal CLI and MCP runtime installation.
- Use the GitHub source archive when tests, smoke scripts, or release reproduction are required.
- Existing read-only SQL policy, profile permissions, tool permissions, output limits, timeout limits, audit logging, and error redaction remain unchanged.

## 中文说明

v1.4.0 是一次打包和公开文档整理版本。本版本不改变数据库只读边界，也不增加新的数据库能力。

### 变更

- 精简 npm 包文件清单，只保留运行时产物、双语文档、部署模板、示例、OpenCode 文件和 CLI 构建产物。
- npm 包不再包含历史 release 文档和 smoke 测试脚本；这些内容不是运行时必需。
- GitHub 源码归档仍保持完整，适合源码构建、审计、smoke test 和发布复现。
- package、server、Docker Compose、Kubernetes、README 和部署示例更新到 v1.4.0。

### 验证

- `npm test`：发布前本地通过。
- `npm run docs:check`：发布前本地通过。
- `npm audit --omit=dev --audit-level=moderate`：发布前本地通过。
- `npm pack --dry-run`：发布前本地通过。
- Release workflow 需要通过 GitHub Actions 发布 npm 包，并附带源码归档、npm tgz、SBOM、amd64/arm64 离线镜像。

### 安装

```bash
npm install -g @sevoniva/oceanbase-mcp@1.4.0
ob-mcp --help
npx --registry=https://registry.npmjs.org/ --yes --package=@sevoniva/oceanbase-mcp@1.4.0 ob-mcp --help
```

### 交付资产

- `sevoniva-oceanbase-mcp-1.4.0.tgz`
- `oceanbase-mcp-1.4.0-source.tar.gz`
- `sbom.cdx.json`
- `oceanbase-mcp-1.4.0-amd64.tar.gz`
- `oceanbase-mcp-1.4.0-arm64.tar.gz`
- `ghcr.io/sevoniva/oceanbase-mcp:v1.4.0`
- `ghcr.io/sevoniva/oceanbase-mcp:1.4.0`

### 说明

- 常规 CLI 和 MCP runtime 安装使用 npm 包。
- 需要测试、smoke 脚本或发布复现时，使用 GitHub 源码归档。
- 既有只读 SQL 策略、profile 权限、tool 权限、输出限制、超时限制、审计日志和错误脱敏保持不变。

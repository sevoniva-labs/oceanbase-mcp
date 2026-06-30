# 配置说明

[English](../en/configuration.md) | [返回](README.md)

配置通过环境变量提供。本地 Node.js 运行时会自动加载 `.env`。

## 最小本地配置

```bash
OB_HOST=127.0.0.1
OB_PORT=2883
OB_USER=ob_user@ob_mysql#obcluster
OB_PASSWORD=ob_password
OB_COMPATIBILITY=mysql
OB_ALLOWED_SCHEMAS=biz_test
```

## 最小生产配置

```bash
NODE_ENV=production
OB_HOST=your-obproxy.example.com
OB_PORT=2883
OB_USER=readonly_user@tenant#cluster
OB_PASSWORD_FILE=/run/secrets/ob_password
OB_COMPATIBILITY=mysql
OB_PRODUCTION=true
OB_MCP_READ_ONLY=true
OB_DB_USER_READ_ONLY=true
OB_ALLOWED_SCHEMAS=app_schema
OB_ALLOW_SELECT_STAR=false
OB_ENFORCE_READ_ONLY_TX=true
OB_MCP_HOST=127.0.0.1
OB_MCP_PORT=3000
OB_MCP_PATH=/mcp
OB_MCP_AUTH_TOKEN_FILE=/run/secrets/ob_mcp_auth_token
OB_MCP_ALLOWED_IPS=127.0.0.1,10.0.0.0/8
```

## 连接配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OB_HOST` | `127.0.0.1` | OceanBase 或 OBProxy 地址。 |
| `OB_PORT` | `2883` | OBProxy 端口。 |
| `OB_USER` | 仅本地默认 | OceanBase 完整用户名，例如 `user@tenant#cluster`。生产必填。 |
| `OB_USERNAME` | `ob_user` | 仅在非生产且未设置 `OB_USER` 时使用。 |
| `OB_TENANT` | `ob_mysql` | 仅在非生产且未设置 `OB_USER` 时使用。 |
| `OB_CLUSTER` | `obcluster` | 仅在非生产且未设置 `OB_USER` 时使用。 |
| `OB_PASSWORD` | 仅本地默认 | 直接密码。生产环境必须设置它或 `OB_PASSWORD_FILE`。 |
| `OB_PASSWORD_FILE` | 未设置 | 保存数据库密码的文件。部署环境推荐使用。 |
| `OB_DATABASE` | 未设置 | MySQL 模式下的默认 database/schema。 |
| `OB_COMPATIBILITY` | `mysql` | `mysql` 或 `oracle`。 |
| `OB_CONNECTION_LIMIT` | `5` | 连接池大小。 |
| `OB_CONNECT_TIMEOUT_MS` | `10000` | 连接超时。 |
| `OB_QUERY_TIMEOUT_MS` | `30000` | 单次查询超时，也会映射为 OceanBase query timeout hint。 |

## 只读与访问策略

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OB_MCP_READ_ONLY` | `true` | MCP 网关只读开关，不可关闭。设置为 `false` 会启动失败。 |
| `OB_DB_USER_READ_ONLY` | `false` | 声明数据库账号本身是只读账号，用于诊断。 |
| `OB_PRODUCTION` | `false` | 启用生产 fail-closed 检查。`NODE_ENV=production` 也会启用。 |
| `OB_ALLOWED_SCHEMAS` | 未设置 | schema allowlist。生产环境必须设置它或 `OB_ALLOWED_TABLES`。 |
| `OB_ALLOWED_TABLES` | 未设置 | table allowlist。使用 `schema.table` 或 `schema.*`。 |
| `OB_DENIED_SCHEMAS` | 系统 schema | 被拒绝的 schema 列表。 |
| `OB_DENIED_TABLES` | 未设置 | 被拒绝的表列表，支持 `*`。 |
| `OB_DENIED_COLUMNS` | 敏感名称 | 被拒绝的列名/标识符列表。 |
| `OB_ALLOW_SELECT_STAR` | `false` | 只有显式设为 `true` 才允许 `SELECT *`。 |
| `OB_REQUIRE_ACCESS_POLICY` | 生产：`true` | 生产环境要求配置 allowlist。 |
| `OB_INCLUDE_SYSTEM_SCHEMAS` | `false` | 元数据工具是否包含系统 schema。 |
| `OB_ENFORCE_READ_ONLY_TX` | `true` | 用户 SQL 是否放入数据库只读事务。 |
| `OB_MAX_ROWS` | `100` | 默认返回行数上限。 |
| `OB_MAX_SQL_LENGTH` | `20000` | SQL 文本长度上限。 |
| `OB_MAX_PARAM_COUNT` | `500` | SQL 参数数量上限。 |

## HTTP 服务

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OB_MCP_HOST` | `127.0.0.1` | HTTP 绑定地址。只有在可信边界后才使用 `0.0.0.0`。 |
| `OB_MCP_PORT` | `3000` | HTTP 端口。 |
| `OB_MCP_PATH` | `/mcp` | MCP endpoint 路径。 |
| `OB_MCP_AUTH_TOKEN` | 未设置 | HTTP MCP Bearer token。生产和非本地绑定必填。 |
| `OB_MCP_AUTH_TOKEN_FILE` | 未设置 | 保存 Bearer token 的文件。 |
| `OB_MCP_ALLOWED_HOSTS` | 未设置 | 允许的 Host header，逗号分隔。非本地绑定必填。 |
| `OB_MCP_ALLOWED_IPS` | 未设置 | 来源 IP/CIDR allowlist，逗号分隔。非本地绑定必填。 |
| `OB_MCP_TRUST_PROXY` | `false` | 是否信任反向代理传入的客户端 IP。只在可信代理/Ingress 后启用。 |
| `OB_MCP_BODY_LIMIT` | `256kb` | JSON 请求体大小上限。 |
| `OB_MCP_RATE_LIMIT_WINDOW_MS` | `60000` | HTTP 限流窗口。 |
| `OB_MCP_RATE_LIMIT_MAX` | `60` | 每个限流窗口内的请求上限。 |

`OB_MCP_ALLOWED_IPS` 支持精确 IP 和 CIDR：

```bash
OB_MCP_ALLOWED_IPS=127.0.0.1,10.0.0.0/8,203.0.113.10,2001:db8::/32
```

部署在 Nginx 或 Kubernetes Ingress 后时，只有代理可信且会处理不可信转发头，才设置 `OB_MCP_TRUST_PROXY=true`。

## TLS

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OB_REQUIRE_TLS` | `false` | 数据库连接必须配置 SSL。 |
| `OB_SSL` | 未设置 | 不提供证书文件时启用 SSL。 |
| `OB_SSL_CA` | 未设置 | CA 证书路径。 |
| `OB_SSL_CERT` | 未设置 | 客户端证书路径。 |
| `OB_SSL_KEY` | 未设置 | 客户端私钥路径。 |
| `OB_SSL_REJECT_UNAUTHORIZED` | `true` | 是否校验证书。 |

HTTP TLS 通常应由 Nginx、Ingress Controller 或云负载均衡终止。

## 多 Profile

profile 用于一个服务连接多个租户或环境。

```bash
OB_PROFILES=dev,prod
OB_DEFAULT_PROFILE=dev

OB_PROFILE_DEV_HOST=127.0.0.1
OB_PROFILE_DEV_USER=dev_user@dev_tenant#obcluster
OB_PROFILE_DEV_PASSWORD_FILE=/run/secrets/dev_ob_password
OB_PROFILE_DEV_ALLOWED_SCHEMAS=dev_app

OB_PROFILE_PROD_HOST=your-obproxy.example.com
OB_PROFILE_PROD_USER=readonly_user@prod_tenant#obcluster
OB_PROFILE_PROD_PASSWORD_FILE=/run/secrets/prod_ob_password
OB_PROFILE_PROD_PRODUCTION=true
OB_PROFILE_PROD_ALLOWED_SCHEMAS=app_schema
```

每个 MCP 工具都支持可选的 `profile` 参数。

## 配置诊断

```bash
npm run config:doctor
```

诊断会检查凭据、只读模式、访问策略、HTTP 认证、Host allowlist、来源 IP allowlist、限流、body 限制和 TLS 状态。

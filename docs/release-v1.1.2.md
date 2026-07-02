# OceanBase MCP v1.1.2

v1.1.2 is a stability hotfix for local OpenCode query workflows. It focuses on repeated query calls, local HTTP rate limiting, crash diagnostics, slow-call logging, and Oracle parameterized SQL compatibility. The read-only boundary is unchanged.

## Changes

- Raised the default local HTTP rate limit from 60 to 600 requests per minute.
- Kept the conservative 60 requests per minute default for production mode and non-local HTTP binds.
- Added optional JSONL file logging through `OB_MCP_LOG_FILE`.
- Added process-level crash logs for uncaught exceptions and unhandled rejections.
- Added slow tool-call and slow HTTP request logs controlled by `OB_MCP_SLOW_CALL_MS`.
- Added explicit HTTP rate-limit and JSON body error log events.
- Added Oracle compatibility for simple `:name` and `:1` bind placeholders when `params` is supplied as a positional array.
- Skips placeholder conversion inside strings, quoted identifiers, and comments.
- Updated SQL assistant and configuration documentation for the local OpenCode query path.
- Updated package, server, Docker Compose, and Kubernetes versions to 1.1.2.

## Validation

- `npm test`
- `npm run docs:check`
- `npm audit --omit=dev --audit-level=moderate`
- `npm pack --dry-run`
- Docker build
- Local OceanBase MySQL smoke test
- Local OceanBase Oracle smoke test
- MySQL and Oracle repeated-query stress tests
- Local HTTP repeated-call stress test
- JSONL logging and redaction unit test
- Local MySQL and Oracle million-row table `ob_describe_table` stress tests
- Regression tests that ensure `ob_describe_table` reads catalog metadata instead of scanning target table data

## Notes

- The MCP server still rejects write, DDL, DCL, procedure calls, sequence `NEXTVAL`, multi-statement SQL, and unsafe SQL patterns.
- For local crash diagnosis, set `OB_MCP_LOG_FILE=/var/log/ob-mcp/ob-mcp.jsonl` and review `process_*`, `slow_tool_call`, `http_rate_limited`, and `json_body_error` events.
- `ob_describe_table` is metadata-only. Large row counts in the target table should not affect it; table context, profiling, and sample tools remain separately bounded by row, timeout, and output-size limits.
- New generated SQL should prefer `?` placeholders. Oracle `:name` support is for compatibility with common assistant output.
- If a shared HTTP deployment needs a higher limit, set `OB_MCP_RATE_LIMIT_MAX` explicitly and keep authentication and IP allowlists enabled.

export interface MetricsSnapshot {
  startedAt: string;
  uptimeSeconds: number;
  httpRequestsTotal: number;
  httpAuthDeniedTotal: number;
  httpErrorsTotal: number;
  activeHttpRequests: number;
  toolCallsTotal: number;
  toolBlockedTotal: number;
  toolErrorsTotal: number;
  activeToolCalls: number;
  queryCount: number;
  queryDurationMsTotal: number;
}

class GatewayMetrics {
  private readonly startedAt = new Date();
  private httpRequestsTotal = 0;
  private httpAuthDeniedTotal = 0;
  private httpErrorsTotal = 0;
  private activeHttpRequests = 0;
  private toolCallsTotal = 0;
  private toolBlockedTotal = 0;
  private toolErrorsTotal = 0;
  private activeToolCalls = 0;
  private queryCount = 0;
  private queryDurationMsTotal = 0;

  startHttpRequest(): () => void {
    this.httpRequestsTotal += 1;
    this.activeHttpRequests += 1;
    return () => {
      this.activeHttpRequests = Math.max(0, this.activeHttpRequests - 1);
    };
  }

  recordHttpAuthDenied(): void {
    this.httpAuthDeniedTotal += 1;
  }

  recordHttpError(): void {
    this.httpErrorsTotal += 1;
  }

  startToolCall(): () => void {
    this.toolCallsTotal += 1;
    this.activeToolCalls += 1;
    return () => {
      this.activeToolCalls = Math.max(0, this.activeToolCalls - 1);
    };
  }

  recordToolBlocked(): void {
    this.toolBlockedTotal += 1;
  }

  recordToolError(): void {
    this.toolErrorsTotal += 1;
  }

  recordQueryDuration(durationMs: number): void {
    this.queryCount += 1;
    this.queryDurationMsTotal += durationMs;
  }

  snapshot(): MetricsSnapshot {
    return {
      startedAt: this.startedAt.toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt.getTime()) / 1000),
      httpRequestsTotal: this.httpRequestsTotal,
      httpAuthDeniedTotal: this.httpAuthDeniedTotal,
      httpErrorsTotal: this.httpErrorsTotal,
      activeHttpRequests: this.activeHttpRequests,
      toolCallsTotal: this.toolCallsTotal,
      toolBlockedTotal: this.toolBlockedTotal,
      toolErrorsTotal: this.toolErrorsTotal,
      activeToolCalls: this.activeToolCalls,
      queryCount: this.queryCount,
      queryDurationMsTotal: this.queryDurationMsTotal
    };
  }

  prometheus(): string {
    const snapshot = this.snapshot();
    return [
      "# TYPE ob_mcp_uptime_seconds gauge",
      `ob_mcp_uptime_seconds ${snapshot.uptimeSeconds}`,
      "# TYPE ob_mcp_http_requests_total counter",
      `ob_mcp_http_requests_total ${snapshot.httpRequestsTotal}`,
      "# TYPE ob_mcp_http_auth_denied_total counter",
      `ob_mcp_http_auth_denied_total ${snapshot.httpAuthDeniedTotal}`,
      "# TYPE ob_mcp_http_errors_total counter",
      `ob_mcp_http_errors_total ${snapshot.httpErrorsTotal}`,
      "# TYPE ob_mcp_active_http_requests gauge",
      `ob_mcp_active_http_requests ${snapshot.activeHttpRequests}`,
      "# TYPE ob_mcp_tool_calls_total counter",
      `ob_mcp_tool_calls_total ${snapshot.toolCallsTotal}`,
      "# TYPE ob_mcp_tool_blocked_total counter",
      `ob_mcp_tool_blocked_total ${snapshot.toolBlockedTotal}`,
      "# TYPE ob_mcp_tool_errors_total counter",
      `ob_mcp_tool_errors_total ${snapshot.toolErrorsTotal}`,
      "# TYPE ob_mcp_active_tool_calls gauge",
      `ob_mcp_active_tool_calls ${snapshot.activeToolCalls}`,
      "# TYPE ob_mcp_query_count counter",
      `ob_mcp_query_count ${snapshot.queryCount}`,
      "# TYPE ob_mcp_query_duration_ms_total counter",
      `ob_mcp_query_duration_ms_total ${snapshot.queryDurationMsTotal}`,
      ""
    ].join("\n");
  }
}

export const metrics = new GatewayMetrics();

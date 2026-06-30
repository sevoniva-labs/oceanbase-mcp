#!/usr/bin/env node
import "dotenv/config";

import { timingSafeEqual } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  hostHeaderValidation,
  localhostHostValidation
} from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import express, { type Request, type Response, type NextFunction } from "express";
import { rateLimit } from "express-rate-limit";

import { loadGatewayConfig, loadHttpConfig } from "./config.js";
import { diagnoseGateway } from "./diagnostics.js";
import { logAudit, logError } from "./errors.js";
import { isIpAllowed } from "./ip-policy.js";
import { metrics } from "./metrics.js";
import { createObMcpServer } from "./mcp.js";
import { closeGatewayRuntime, createGatewayRuntime } from "./runtime.js";

const gatewayConfig = loadGatewayConfig();
const httpConfig = loadHttpConfig(gatewayConfig.profiles[gatewayConfig.defaultProfile]);
const runtime = createGatewayRuntime(gatewayConfig);

const app = express();
app.set("trust proxy", httpConfig.trustProxy);

app.use(
  httpConfig.allowedHosts && httpConfig.allowedHosts.length > 0
    ? hostHeaderValidation(httpConfig.allowedHosts)
    : localhostHostValidation()
);

app.use((req, res, next) => {
  const finish = metrics.startHttpRequest();
  res.on("finish", finish);
  next();
});

app.use(restrictSourceIp);

app.get("/healthz", (_req, res) => {
  const diagnostics = diagnoseGateway(gatewayConfig, httpConfig);
  res.status(diagnostics.ok ? 200 : 503).json({
    ok: diagnostics.ok,
    name: "ob-mcp",
    mode: "http",
    defaultProfile: gatewayConfig.defaultProfile,
    profiles: Object.keys(gatewayConfig.profiles),
    metrics: metrics.snapshot()
  });
});

app.get("/metrics", (_req, res) => {
  res.type("text/plain; version=0.0.4").send(metrics.prometheus());
});

app.use(
  httpConfig.path,
  rateLimit({
    windowMs: httpConfig.rateLimitWindowMs,
    limit: httpConfig.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false
  }),
  authenticate,
  express.json({ limit: httpConfig.bodyLimit }),
  jsonBodyErrorHandler
);

app.post(httpConfig.path, async (req, res) => {
  const server = createObMcpServer(runtime, httpConfig);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    metrics.recordHttpError();
    logError("http_mcp", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error"
        },
        id: null
      });
    }
  }
});

app.get(httpConfig.path, (_req, res) => methodNotAllowed(res));
app.delete(httpConfig.path, (_req, res) => methodNotAllowed(res));
app.put(httpConfig.path, (_req, res) => methodNotAllowed(res));
app.patch(httpConfig.path, (_req, res) => methodNotAllowed(res));

const httpServer = app.listen(httpConfig.port, httpConfig.host, () => {
  logAudit("http_start", {
    host: httpConfig.host,
    port: httpConfig.port,
    path: httpConfig.path,
    authEnabled: Boolean(httpConfig.authToken),
    ipAllowlistEnabled: httpConfig.allowedIps.length > 0,
    trustProxy: httpConfig.trustProxy
  });
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function authenticate(req: Request, res: Response, next: NextFunction): void {
  if (!httpConfig.authToken) {
    next();
    return;
  }

  if (!isBearerTokenValid(req.header("authorization"), httpConfig.authToken)) {
    metrics.recordHttpAuthDenied();
    logAudit("http_auth_denied", {
      path: req.path,
      remoteAddress: req.socket.remoteAddress
    });
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

function restrictSourceIp(req: Request, res: Response, next: NextFunction): void {
  if (isIpAllowed(req.ip || req.socket.remoteAddress, httpConfig.allowedIps)) {
    next();
    return;
  }

  metrics.recordHttpAuthDenied();
  logAudit("http_ip_denied", {
    path: req.path,
    ip: req.ip,
    remoteAddress: req.socket.remoteAddress,
    forwardedFor: req.header("x-forwarded-for")
  });
  res.status(403).json({ error: "Forbidden" });
}

function isBearerTokenValid(header: string | undefined, expectedToken: string): boolean {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) {
    return false;
  }

  const provided = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(expectedToken);
  const maxLength = Math.max(provided.length, expected.length);
  const paddedProvided = Buffer.alloc(maxLength);
  const paddedExpected = Buffer.alloc(maxLength);
  provided.copy(paddedProvided);
  expected.copy(paddedExpected);

  return timingSafeEqual(paddedProvided, paddedExpected) && provided.length === expected.length;
}

function jsonBodyErrorHandler(
  error: Error & { status?: number },
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!error) {
    next();
    return;
  }

  const status = error.status === 413 ? 413 : 400;
  res.status(status).json({
    jsonrpc: "2.0",
    error: {
      code: -32700,
      message: status === 413 ? "Request body too large." : "Invalid JSON request body."
    },
    id: null
  });
}

function methodNotAllowed(res: Response): void {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed."
    },
    id: null
  });
}

async function shutdown(): Promise<void> {
  httpServer.close();
  await closeGatewayRuntime(runtime);
  process.exit(0);
}

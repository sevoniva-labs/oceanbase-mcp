#!/usr/bin/env node
import "dotenv/config";

import { randomUUID, timingSafeEqual } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  hostHeaderValidation,
  localhostHostValidation
} from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import express, { type Request, type Response, type NextFunction } from "express";
import { rateLimit } from "express-rate-limit";

import { loadGatewayConfig, loadHttpConfig, type AuthPrincipal, type AuthTokenPolicy } from "./config.js";
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
  attachRequestContext(req, res);
  const finish = metrics.startHttpRequest();
  res.on("finish", finish);
  next();
});

app.use(restrictSourceIp);

app.get("/healthz", endpointAuth(httpConfig.healthAuthRequired), (_req, res) => {
  const diagnostics = diagnoseGateway(gatewayConfig, httpConfig);
  res.status(diagnostics.ok ? 200 : 503).json({
    ok: diagnostics.ok,
    name: "ob-mcp",
    mode: "http",
    profileCount: Object.keys(gatewayConfig.profiles).length
  });
});

app.get("/metrics", endpointAuth(httpConfig.metricsAuthRequired), (_req, res) => {
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
  const requestContext = getRequestContext(req);
  const server = createObMcpServer(runtime, httpConfig, {
    ...requestContext,
    transport: "http"
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });
  let closed = false;
  const cleanup = () => {
    if (closed) {
      return;
    }
    closed = true;
    transport.close();
    server.close();
  };
  res.once("finish", cleanup);
  res.once("close", cleanup);

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
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
    cleanup();
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
    authEnabled: httpConfig.authTokens.length > 0,
    tokenPolicyCount: httpConfig.authTokens.length,
    ipAllowlistEnabled: httpConfig.allowedIps.length > 0,
    trustProxy: httpConfig.trustProxyDescription,
    metricsAuthRequired: httpConfig.metricsAuthRequired,
    healthAuthRequired: httpConfig.healthAuthRequired
  });
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function authenticate(req: Request, res: Response, next: NextFunction): void {
  if (httpConfig.authTokens.length === 0) {
    next();
    return;
  }

  const policy = findBearerTokenPolicy(req.header("authorization"), httpConfig.authTokens);
  if (!policy) {
    metrics.recordHttpAuthDenied();
    logAudit("http_auth_denied", {
      path: req.path,
      remoteAddress: req.socket.remoteAddress,
      requestId: getRequestContext(req).requestId,
      clientId: getRequestContext(req).clientId
    });
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  setAuthPrincipal(req, {
    name: policy.name,
    profiles: policy.profiles,
    tools: policy.tools
  });
  next();
}

function endpointAuth(required: boolean) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!required) {
      next();
      return;
    }
    authenticate(req, res, next);
  };
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
    forwardedFor: req.header("x-forwarded-for"),
    requestId: getRequestContext(req).requestId,
    clientId: getRequestContext(req).clientId
  });
  res.status(403).json({ error: "Forbidden" });
}

function findBearerTokenPolicy(
  header: string | undefined,
  policies: AuthTokenPolicy[]
): AuthTokenPolicy | undefined {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) {
    return undefined;
  }

  const provided = Buffer.from(header.slice(prefix.length));
  let matched: AuthTokenPolicy | undefined;
  for (const policy of policies) {
    if (isTokenMatch(provided, policy.token)) {
      matched = policy;
    }
  }
  return matched;
}

function isTokenMatch(provided: Buffer, expectedToken: string): boolean {
  const expected = Buffer.from(expectedToken);
  const maxLength = Math.max(provided.length, expected.length);
  const paddedProvided = Buffer.alloc(maxLength);
  const paddedExpected = Buffer.alloc(maxLength);
  provided.copy(paddedProvided);
  expected.copy(paddedExpected);

  return timingSafeEqual(paddedProvided, paddedExpected) && provided.length === expected.length;
}

interface RequestContext {
  requestId: string;
  clientId?: string;
  principal?: AuthPrincipal;
}

type RequestWithContext = Request & {
  obMcpContext?: RequestContext;
};

function attachRequestContext(req: Request, res: Response): void {
  const requestId = sanitizeHeaderValue(req.header("x-request-id")) || randomUUID();
  const clientId = sanitizeHeaderValue(req.header(httpConfig.clientIdHeader));
  (req as RequestWithContext).obMcpContext = {
    requestId,
    clientId
  };
  res.setHeader("x-request-id", requestId);
}

function getRequestContext(req: Request): RequestContext {
  return (req as RequestWithContext).obMcpContext ?? { requestId: randomUUID() };
}

function setAuthPrincipal(req: Request, principal: AuthPrincipal): void {
  const context = getRequestContext(req);
  (req as RequestWithContext).obMcpContext = {
    ...context,
    principal
  };
}

function sanitizeHeaderValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) {
    return undefined;
  }
  return trimmed.slice(0, 256);
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

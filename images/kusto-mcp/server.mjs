#!/usr/bin/env node
// Kusto MCP server entry point. Configuration comes from the environment; see
// README.md.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ArmClient } from "./src/arm.mjs";
import { TokenProvider } from "./src/auth.mjs";
import { KustoClient } from "./src/kusto.mjs";
import { createDispatcher, makeRedactor, serveHttp, serveStdio } from "./src/mcp.mjs";
import { INSTRUCTIONS, Tools } from "./src/tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const flag = (name, fallback = false) => {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
};
const number = (name, fallback, min, max) => {
  const value = Number(env[name]);
  return env[name] !== undefined && env[name] !== "" && Number.isFinite(value) && value >= min ? Math.min(value, max) : fallback;
};
const list = (name) => (env[name] ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);

function secret(name) {
  if (env[name]?.trim()) return env[name].trim();
  const file = env[`${name}_FILE`];
  if (!file) return undefined;
  try {
    const text = readFileSync(file, "utf8");
    if (text.length > 16_384) throw new Error("file is unexpectedly large");
    return text.trim() || undefined;
  } catch (error) {
    process.stderr.write(`kusto-mcp: cannot read ${name}_FILE: ${error.code ?? error.message}\n`);
    return undefined;
  }
}

const clientSecret = secret("AZURE_CLIENT_SECRET");
const httpToken = secret("MCP_HTTP_TOKEN");
const redact = makeRedactor(clientSecret, httpToken);
const verbose = flag("KUSTO_LOG_REQUESTS");
const log = (line) => process.stderr.write(`kusto-mcp: ${redact(line)}\n`);
const version = readFileSync(join(here, "VERSION"), "utf8").trim();

const mode = (env.KUSTO_MCP_TOOLS ?? "both").toLowerCase();
if (!["both", "namespace", "all"].includes(mode)) {
  process.stderr.write(`kusto-mcp: KUSTO_MCP_TOOLS must be both, namespace, or all\n`);
  process.exit(2);
}

const config = {
  enableWrites: flag("KUSTO_ENABLE_WRITES"),
  queryReadOnly: flag("KUSTO_QUERY_READONLY", true),
  readOnlyHardline: flag("KUSTO_READONLY_HARDLINE"),
  defaultSubscription: env.AZURE_SUBSCRIPTION_ID || undefined,
  maxV2QueryLength: number("KUSTO_MAX_QUERY_LENGTH_V2", 65_536, 1_000, 1_000_000),
  maxIngestBytes: number("KUSTO_MAX_INGEST_BYTES", 4 * 1024 * 1024, 1_024, 64 * 1024 * 1024),
};

const tokens = new TokenProvider({
  tenantId: env.AZURE_TENANT_ID,
  clientId: env.AZURE_CLIENT_ID,
  clientSecret,
  authorityHost: env.AZURE_AUTHORITY_HOST || "https://login.microsoftonline.com",
});
if (!tokens.configured) log("AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET are required for tool calls; serving tools/list only");

const kusto = new KustoClient({
  tokens,
  version,
  timeoutMs: number("KUSTO_TIMEOUT_MS", 240_000, 1_000, 3_600_000),
  retries: number("KUSTO_RETRIES", 3, 0, 6),
  maxConcurrency: number("KUSTO_MAX_CONCURRENCY", 8, 1, 64),
  maxResponseBytes: number("KUSTO_MAX_RESPONSE_BYTES", 16 * 1024 * 1024, 65_536, 512 * 1024 * 1024),
  extraSuffixes: list("KUSTO_EXTRA_HOST_SUFFIXES").map((suffix) => (suffix.startsWith(".") ? suffix : `.${suffix}`)),
  extraHosts: list("KUSTO_EXTRA_HOSTS"),
  allowedClusters: list("KUSTO_ALLOWED_CLUSTERS"),
  allowHttp: flag("KUSTO_ALLOW_HTTP"),
  scopeOverride: env.KUSTO_SCOPE || undefined,
  log: verbose ? log : () => {},
});
const arm = new ArmClient({
  tokens,
  endpoint: env.AZURE_RESOURCE_MANAGER_URL || "https://management.azure.com",
  defaultSubscription: config.defaultSubscription,
  retries: number("KUSTO_RETRIES", 3, 0, 6),
});

const tools = new Tools({ kusto, arm, config, mode });
const dispatch = createDispatcher({ tools, version, instructions: INSTRUCTIONS, redact, log: verbose ? log : () => {} });

let httpServer;
const shutdown = (code = 0) => {
  if (httpServer) httpServer.close();
  process.exit(code);
};
process.on("SIGTERM", () => shutdown(0));
// Last-resort net: log and keep serving rather than drop every call in flight.
process.on("unhandledRejection", (error) => log(`unhandled rejection: ${error?.stack ?? error}`));
process.on("SIGINT", () => shutdown(0));

const transport = env.MCP_TRANSPORT ?? "stdio";
if (transport === "http") {
  try {
    httpServer = serveHttp({ dispatch, token: httpToken, port: number("PORT", 8080, 0, 65535), host: env.HOST ?? "0.0.0.0", log });
  } catch (error) {
    process.stderr.write(`kusto-mcp: ${error.message}\n`);
    process.exit(2);
  }
} else if (transport === "stdio") {
  serveStdio({ dispatch, onClose: () => shutdown(0) });
} else {
  process.stderr.write(`kusto-mcp: unknown MCP_TRANSPORT ${JSON.stringify(transport)}\n`);
  process.exit(2);
}

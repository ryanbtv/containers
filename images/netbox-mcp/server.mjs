#!/usr/bin/env node
// NetBox MCP server entry point. Configuration comes from the environment;
// see README.md.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDispatcher, serveHttp, serveStdio } from "./src/mcp.mjs";
import { makeRedactor, NetBoxClient } from "./src/netbox.mjs";
import { Tools } from "./src/tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const flag = (name) => /^(1|true|yes|on)$/i.test(env[name] ?? "");
const number = (name, fallback, min, max) => {
  const value = Number(env[name]);
  return Number.isFinite(value) && value >= min ? Math.min(value, max) : fallback;
};
const log = (line) => process.stderr.write(`netbox-mcp: ${redact(line)}\n`);

function readToken() {
  if (env.NETBOX_TOKEN?.trim()) return env.NETBOX_TOKEN.trim();
  if (!env.NETBOX_TOKEN_FILE) return undefined;
  try {
    const text = readFileSync(env.NETBOX_TOKEN_FILE, "utf8");
    if (text.length > 16_384) throw new Error("file is unexpectedly large");
    return text.trim() || undefined;
  } catch (error) {
    process.stderr.write(`netbox-mcp: cannot read NETBOX_TOKEN_FILE: ${error.code ?? error.message}\n`);
    return undefined;
  }
}

const token = readToken();
const redact = makeRedactor(token, env.MCP_HTTP_TOKEN);
if (/^(0|false|no|off)$/i.test(env.NETBOX_VERIFY_TLS ?? "")) {
  // Global fetch has no per-request TLS option without undici; this is the
  // documented process-wide switch. Prefer NODE_EXTRA_CA_CERTS for a private CA.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const version = readFileSync(join(here, "VERSION"), "utf8").trim();
const readOnly = flag("NETBOX_READ_ONLY");
const verbose = flag("NETBOX_LOG_REQUESTS");

let client;
try {
  client = new NetBoxClient({
    url: env.NETBOX_URL,
    token,
    maxConcurrency: number("NETBOX_MAX_CONCURRENCY", 3, 1, 16),
    timeoutMs: number("NETBOX_TIMEOUT_MS", 30_000, 1_000, 600_000),
    writeTimeoutMs: number("NETBOX_WRITE_TIMEOUT_MS", 120_000, 1_000, 600_000),
    retries: number("NETBOX_RETRIES", 3, 0, 6),
    log: verbose ? log : () => {},
  });
} catch (error) {
  process.stderr.write(`netbox-mcp: ${redact(error.message)}\n`);
  process.exit(2);
}
if (!client.baseUrl || !client.token) log("NETBOX_URL and NETBOX_TOKEN are required for tool calls; serving tools/list only");

const tools = new Tools({
  client,
  catalogPath: env.NETBOX_CATALOG ?? join(here, "catalog.json"),
  readOnly,
  allowAdminWrites: flag("NETBOX_ALLOW_ADMIN_WRITES"),
  maxOutputBytes: number("NETBOX_MAX_OUTPUT_BYTES", 100_000, 4_096, 10_000_000),
});
const dispatch = createDispatcher({ tools, readOnly, version, redact, log: verbose ? log : () => {} });

let httpServer;
const shutdown = (code = 0) => {
  if (httpServer) httpServer.close();
  process.exit(code);
};
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

if ((env.MCP_TRANSPORT ?? "stdio") === "http") {
  try {
    httpServer = serveHttp({ dispatch, token: env.MCP_HTTP_TOKEN, port: number("PORT", 8080, 0, 65535), host: env.HOST ?? "0.0.0.0", log });
  } catch (error) {
    process.stderr.write(`netbox-mcp: ${error.message}\n`);
    process.exit(2);
  }
} else if ((env.MCP_TRANSPORT ?? "stdio") === "stdio") {
  serveStdio({ dispatch, onClose: () => shutdown(0) });
} else {
  process.stderr.write(`netbox-mcp: unknown MCP_TRANSPORT ${JSON.stringify(env.MCP_TRANSPORT)}\n`);
  process.exit(2);
}

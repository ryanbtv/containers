// JSON-RPC dispatch plus the stdio and streamable-HTTP transports.
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { INSTRUCTIONS, listTools } from "./tools.mjs";

export const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
export const MAX_LINE_BYTES = 1024 * 1024;

export function createDispatcher({ tools, readOnly, version, redact, log = () => {} }) {
  const listed = { tools: listTools({ readOnly }) };
  return async function dispatch(message) {
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32600, message: "invalid JSON-RPC request" } };
    }
    const { id, method, params } = message;
    if (id === undefined) return undefined; // notification
    const reply = (result) => ({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        return reply({
          protocolVersion: SUPPORTED_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "netbox-mcp", version },
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply(listed);
      case "tools/call": {
        const name = params?.name;
        const started = Date.now();
        try {
          const text = await tools.call(name, params?.arguments ?? {});
          log(`tool ${name} ok ${Date.now() - started}ms`);
          return reply({ content: [{ type: "text", text: redact(text) }] });
        } catch (error) {
          log(`tool ${name} error ${Date.now() - started}ms`);
          const text = redact(error?.message ?? String(error)).slice(0, 4000);
          return reply({ isError: true, content: [{ type: "text", text }] });
        }
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
    }
  };
}

/** Newline-delimited JSON-RPC on stdin/stdout. Calls run concurrently. */
export function serveStdio({ dispatch, input = process.stdin, output = process.stdout, onClose = () => {} }) {
  const inflight = new Set();
  let buffer = "";
  let dropping = false;
  const send = (message) => {
    if (message) output.write(`${JSON.stringify(message)}\n`);
  };
  const handleLine = (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    const task = dispatch(message)
      .then(send)
      .catch((error) => send({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32603, message: String(error?.message ?? error).slice(0, 500) } }))
      .finally(() => inflight.delete(task));
    inflight.add(task);
  };
  input.setEncoding?.("utf8");
  input.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (dropping) {
        dropping = false;
        continue;
      }
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `request exceeds ${MAX_LINE_BYTES} bytes` } });
        continue;
      }
      handleLine(line);
    }
    if (!dropping && Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
      buffer = "";
      dropping = true;
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `request exceeds ${MAX_LINE_BYTES} bytes` } });
    }
  });
  input.on("end", async () => {
    if (!dropping && buffer.trim()) handleLine(buffer);
    await Promise.allSettled([...inflight]);
    onClose();
  });
}

function tokenMatches(header, expected) {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match) return false;
  const given = Buffer.from(match[1].trim());
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/**
 * Minimal stateless streamable HTTP: POST /mcp takes one JSON-RPC message and
 * answers with JSON. GET /health is unauthenticated. Everything else needs
 * Authorization: Bearer <MCP_HTTP_TOKEN>.
 */
export function serveHttp({ dispatch, token, port = 8080, host = "0.0.0.0", log = () => {} }) {
  if (typeof token !== "string" || token.length < 16) {
    throw new Error("MCP_TRANSPORT=http requires MCP_HTTP_TOKEN (at least 16 characters)");
  }
  const server = createServer(async (request, response) => {
    const json = (status, body, headers = {}) => {
      response.writeHead(status, { "Content-Type": "application/json", ...headers });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/health" && request.method === "GET") return json(200, { ok: true });
    if (url.pathname !== "/mcp") return json(404, { error: "not found" });
    if (!tokenMatches(request.headers.authorization, token)) return json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
    if (request.method !== "POST") return json(405, { error: "only POST is supported" }, { Allow: "POST" });
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_LINE_BYTES) return json(413, { error: "request too large" });
      chunks.push(chunk);
    }
    let message;
    try {
      message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    if (Array.isArray(message)) return json(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "batches are not supported" } });
    const reply = await dispatch(message);
    if (!reply) return json(202, undefined);
    return json(200, reply);
  });
  server.listen(port, host, () => log(`listening on ${host}:${server.address().port}`));
  return server;
}

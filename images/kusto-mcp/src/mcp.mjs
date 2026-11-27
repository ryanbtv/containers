// JSON-RPC dispatch plus the stdio and streamable-HTTP transports. Adapted from
// images/netbox-mcp/src/mcp.mjs.
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

export const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/** Replace secret values and bearer tokens in text. */
export function makeRedactor(...secrets) {
  const values = secrets.filter((secret) => typeof secret === "string" && secret.length >= 4);
  return (input) => {
    let text = String(input);
    for (const secret of values) text = text.split(secret).join("[REDACTED]");
    return text.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]");
  };
}

export function createDispatcher({ tools, version, instructions, redact = (text) => text, log = () => {} }) {
  const listed = { tools: tools.list() };
  return async function dispatch(message, { signal, onCancel } = {}) {
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
      return { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32600, message: "invalid JSON-RPC request" } };
    }
    // A response to a server request (none are sent) is accepted and ignored.
    if (message.method === undefined && ("result" in message || "error" in message)) return undefined;
    if (typeof message.method !== "string") {
      return { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32600, message: "invalid JSON-RPC request" } };
    }
    const { id, method, params } = message;
    if (id === undefined) {
      if (method === "notifications/cancelled") onCancel?.(params?.requestId);
      return undefined; // notification
    }
    const reply = (result) => ({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        return reply({
          protocolVersion: SUPPORTED_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "kusto-mcp", version },
          instructions,
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
          const result = await tools.call(name, params?.arguments ?? {}, { signal });
          log(`tool ${name} ${result.isError ? "error" : "ok"} ${Date.now() - started}ms`);
          return reply({ ...result, content: result.content.map((item) => ({ ...item, text: redact(item.text) })) });
        } catch (error) {
          log(`tool ${name} exception ${Date.now() - started}ms`);
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
  const controllers = new Map();
  const onCancel = (requestId) => controllers.get(requestId)?.abort(new Error("cancelled by client"));
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
    const controller = new AbortController();
    const id = message?.id;
    if (id !== undefined && id !== null) controllers.set(id, controller);
    const task = dispatch(message, { signal: controller.signal, onCancel })
      // MCP: the receiver of a cancellation should not answer the request.
      .then((reply) => (controller.signal.aborted ? undefined : send(reply)))
      .catch((error) => send({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32603, message: String(error?.message ?? error).slice(0, 500) } }))
      .finally(() => {
        inflight.delete(task);
        if (controllers.get(id) === controller) controllers.delete(id);
      });
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
      if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) {
        send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `request exceeds ${MAX_MESSAGE_BYTES} bytes` } });
        continue;
      }
      handleLine(line);
    }
    if (!dropping && Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
      buffer = "";
      dropping = true;
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `request exceeds ${MAX_MESSAGE_BYTES} bytes` } });
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
  const handle = async (request, response) => {
    const json = (status, body, headers = {}) => {
      if (response.headersSent || response.destroyed) return;
      response.writeHead(status, { "Content-Type": "application/json", ...headers });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    let url;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      return json(400, { error: "bad request target" });
    }
    if (url.pathname === "/health" && request.method === "GET") return json(200, { ok: true });
    if (url.pathname !== "/mcp") return json(404, { error: "not found" });
    if (!tokenMatches(request.headers.authorization, token)) return json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
    if (request.method !== "POST") return json(405, { error: "only POST is supported" }, { Allow: "POST" });
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_MESSAGE_BYTES) return json(413, { error: "request too large" });
      chunks.push(chunk);
    }
    let message;
    try {
      message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    if (Array.isArray(message)) return json(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "batches are not supported" } });
    // A client that disconnects cancels its call, and the Kusto request with it.
    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) controller.abort(new Error("client disconnected"));
    });
    const reply = await dispatch(message, { signal: controller.signal });
    if (!reply) return json(202, undefined);
    return json(200, reply);
  };
  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      log(`request failed: ${error?.code ?? error?.message ?? error}`);
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(error?.code === "ECONNRESET" || error?.message === "aborted" ? 400 : 500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "request failed" }));
      } else {
        response.destroy();
      }
    });
  });
  server.on("clientError", (error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    else socket.destroy();
  });
  // requestTimeout bounds receiving a request, not the time to answer it, so a
  // long Kusto query is unaffected. keepAliveTimeout outlives Go's idle pool.
  server.requestTimeout = 60_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 65_000;
  server.maxConnections = 256;
  server.listen(port, host, () => log(`listening on ${host}:${server.address().port}`));
  return server;
}

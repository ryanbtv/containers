import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { devices, startFakeNetBox, TOKEN } from "./fake-netbox.mjs";

const server = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");

function spawnServer(env) {
  const child = spawn(process.execPath, [server], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, ...env },
  });
  let buffer = "";
  let stderr = "";
  const waiting = new Map();
  const lines = [];
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      lines.push(line);
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  let next = 0;
  const send = (method, params) => new Promise((resolve) => {
    const id = ++next;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const raw = (text, id) => new Promise((resolve) => {
    waiting.set(id, resolve);
    child.stdin.write(text);
  });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { child, send, raw, exited, lines, get stderr() { return stderr; } };
}

describe("stdio transport", () => {
  let fake;
  before(async () => {
    fake = await startFakeNetBox();
    fake.seed("/api/dcim/devices/", devices(5));
  });
  after(async () => {
    await fake.close();
  });

  it("speaks MCP end to end and exits cleanly on stdin EOF", async () => {
    const proc = spawnServer({ NETBOX_URL: fake.url, NETBOX_TOKEN: TOKEN });
    const init = await proc.send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "netbox-mcp");
    assert.match(init.result.instructions, /fields=/);
    proc.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    assert.deepEqual((await proc.send("ping", {})).result, {});
    const list = await proc.send("tools/list", {});
    assert.equal(list.result.tools.length, 16);
    assert.equal((await proc.send("resources/list", {})).error.code, -32601);
    assert.equal((await proc.raw("{not json}\n", null)).error.code, -32700);

    const [a, b] = await Promise.all([
      proc.send("tools/call", { name: "count_objects", arguments: { queries: [{ type: "dcim.devices" }] } }),
      proc.send("tools/call", { name: "get_objects", arguments: { type: "dcim.devices", limit: 2 } }),
    ]);
    assert.equal(JSON.parse(a.result.content[0].text).counts[0].count, 5);
    assert.equal(JSON.parse(b.result.content[0].text).returned, 2);

    const failure = await proc.send("tools/call", { name: "get_objects", arguments: { type: "nope" } });
    assert.equal(failure.result.isError, true);
    assert.match(failure.result.content[0].text, /unknown type/);

    proc.child.stdin.end();
    assert.deepEqual(await proc.exited, { code: 0, signal: null });
    assert.equal(proc.lines.join("\n").includes(TOKEN), false);
    assert.equal(proc.stderr.includes(TOKEN), false);
  });

  it("never leaks the token in tool errors", async () => {
    fake.route("GET", "/api/dcim/sites/", (request) => ({ status: 400, body: { detail: `bad auth ${request.headers.authorization}` } }));
    const proc = spawnServer({ NETBOX_URL: fake.url, NETBOX_TOKEN: TOKEN, NETBOX_LOG_REQUESTS: "1" });
    const reply = await proc.send("tools/call", { name: "get_objects", arguments: { type: "dcim.sites" } });
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /HTTP 400/);
    proc.child.stdin.end();
    await proc.exited;
    assert.equal(proc.lines.join("\n").includes(TOKEN), false);
    assert.equal(proc.stderr.includes(TOKEN), false);
  });

  it("hides write tools with NETBOX_READ_ONLY=1 and still lists tools without configuration", async () => {
    const proc = spawnServer({ NETBOX_READ_ONLY: "1" });
    const list = await proc.send("tools/list", {});
    const names = list.result.tools.map((tool) => tool.name);
    assert.equal(names.length, 12);
    assert.equal(names.some((name) => /^(create|update|allocate|delete)_/.test(name)), false);
    const refused = await proc.send("tools/call", { name: "delete_objects", arguments: { type: "dcim.devices", ids: [1], confirm: 1 } });
    assert.match(refused.result.content[0].text, /NETBOX_READ_ONLY/);
    const unconfigured = await proc.send("tools/call", { name: "get_objects", arguments: { type: "dcim.devices" } });
    assert.match(unconfigured.result.content[0].text, /NETBOX_URL is not set/);
    proc.child.kill("SIGTERM");
    assert.equal((await proc.exited).code, 0);
  });

  it("rejects oversized lines", async () => {
    const proc = spawnServer({});
    const reply = await proc.raw(`${"x".repeat(1024 * 1024 + 10)}\n`, null);
    assert.equal(reply.error.code, -32600);
    assert.deepEqual((await proc.send("ping", {})).result, {});
    proc.child.stdin.end();
    await proc.exited;
  });
});

describe("HTTP transport", () => {
  it("refuses to start without MCP_HTTP_TOKEN", async () => {
    const proc = spawnServer({ MCP_TRANSPORT: "http", PORT: "0" });
    const { code } = await proc.exited;
    assert.equal(code, 2);
    assert.match(proc.stderr, /requires MCP_HTTP_TOKEN/);
  });

  it("requires the bearer token on /mcp and serves /health openly", async () => {
    const httpToken = "http-token-0123456789abcdef";
    const proc = spawnServer({ MCP_TRANSPORT: "http", PORT: "0", HOST: "127.0.0.1", MCP_HTTP_TOKEN: httpToken, NETBOX_LOG_REQUESTS: "1" });
    const port = await new Promise((resolve) => {
      const timer = setInterval(() => {
        const match = /listening on [^:]+:(\d+)/.exec(proc.stderr);
        if (match) {
          clearInterval(timer);
          resolve(Number(match[1]));
        }
      }, 10);
    });
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal((await fetch(`${base}/mcp`, { method: "POST", body })).status, 401);
    assert.equal((await fetch(`${base}/mcp`, { method: "POST", body, headers: { Authorization: "Bearer wrong-token-0123456789abc" } })).status, 401);
    const ok = await fetch(`${base}/mcp`, { method: "POST", body, headers: { Authorization: `Bearer ${httpToken}`, "Content-Type": "application/json" } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).result.tools.length, 16);
    const note = await fetch(`${base}/mcp`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), headers: { Authorization: `Bearer ${httpToken}` } });
    assert.equal(note.status, 202);
    assert.equal((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${httpToken}` } })).status, 405);
    proc.child.kill("SIGTERM");
    assert.equal((await proc.exited).code, 0);
  });
});

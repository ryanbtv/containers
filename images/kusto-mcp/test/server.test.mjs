import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { CLIENT_SECRET, fakeEnv, startFakeAzure, v1 } from "./fake-azure.mjs";

const server = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");
const HTTP_TOKEN = "http-token-0123456789abcdef";

function spawnServer(env) {
  const child = spawn(process.execPath, [server], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, ...env } });
  let buffer = "";
  let stderr = "";
  const waiting = new Map();
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
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
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, send, exited, get stderr() { return stderr; } };
}

async function waitForListening(proc) {
  for (let i = 0; i < 100; i++) {
    const match = /listening on [^:]+:(\d+)/.exec(proc.stderr);
    if (match) return Number(match[1]);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not start: ${proc.stderr}`);
}

let fake;
before(async () => {
  fake = await startFakeAzure();
});
after(async () => fake.close());

describe("stdio transport", () => {
  it("speaks MCP end to end and exits on stdin EOF", async () => {
    fake.reset();
    fake.handlers.set("T | take 1", v1([["a", "int"]], [[1]]));
    const proc = spawnServer(fakeEnv(fake));
    const init = await proc.send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.equal(init.result.serverInfo.name, "kusto-mcp");
    assert.equal(init.result.serverInfo.version, "1.0.0");
    const listed = await proc.send("tools/list");
    assert.equal(listed.result.tools[0].name, "kusto");
    const called = await proc.send("tools/call", { name: "kusto", arguments: { intent: "q", command: "kusto_query", parameters: { query: "T | take 1", database: "d", "cluster-uri": fake.url } } });
    assert.deepEqual(JSON.parse(called.result.content[0].text).results, { items: [{ a: "int" }, [1]] });
    const unknown = await proc.send("nope");
    assert.equal(unknown.error.code, -32601);
    proc.child.stdin.end();
    assert.equal(await proc.exited, 0);
    assert.doesNotMatch(proc.stderr, new RegExp(CLIENT_SECRET));
  });

  it("honors notifications/cancelled: aborts the call and sends no answer", async () => {
    fake.reset();
    fake.handlers.set("T | take 1", { __delay: 1500, body: v1([["a", "int"]], [[1]]) });
    const proc = spawnServer(fakeEnv(fake));
    let answered = false;
    proc.send("tools/call", { name: "kusto_query", arguments: { query: "T | take 1", database: "d", "cluster-uri": fake.url } }).then(() => { answered = true; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    proc.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1, reason: "test" } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    assert.equal(answered, false);
    assert.equal((await proc.send("ping")).result !== undefined, true);
    proc.child.stdin.end();
    await proc.exited;
  });

  it("serves tools/list without credentials and fails calls clearly", async () => {
    const proc = spawnServer({ KUSTO_MCP_TOOLS: "namespace" });
    const listed = await proc.send("tools/list");
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["kusto"]);
    const called = await proc.send("tools/call", { name: "kusto_query", arguments: {} });
    assert.equal(called.result.isError, true);
    proc.child.stdin.end();
    await proc.exited;
    assert.match(proc.stderr, /serving tools\/list only/);
  });

  it("lists write tools only with KUSTO_ENABLE_WRITES=1", async () => {
    const proc = spawnServer({ KUSTO_ENABLE_WRITES: "1", KUSTO_MCP_TOOLS: "all" });
    const names = (await proc.send("tools/list")).result.tools.map((tool) => tool.name);
    assert.ok(names.includes("kusto_command_write"));
    assert.ok(!names.includes("kusto"));
    proc.child.stdin.end();
    await proc.exited;
  });

  it("rejects a bad KUSTO_MCP_TOOLS value", async () => {
    const proc = spawnServer({ KUSTO_MCP_TOOLS: "some" });
    assert.equal(await proc.exited, 2);
  });
});

describe("HTTP transport", () => {
  let proc;
  let base;
  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "kusto-mcp-"));
    writeFileSync(join(dir, "token"), `${HTTP_TOKEN}\n`);
    writeFileSync(join(dir, "secret"), CLIENT_SECRET);
    const env = fakeEnv(fake, { MCP_TRANSPORT: "http", PORT: "0", HOST: "127.0.0.1", MCP_HTTP_TOKEN_FILE: join(dir, "token"), AZURE_CLIENT_SECRET_FILE: join(dir, "secret"), KUSTO_LOG_REQUESTS: "1" });
    delete env.AZURE_CLIENT_SECRET;
    proc = spawnServer(env);
    base = `http://127.0.0.1:${await waitForListening(proc)}`;
  });
  after(async () => {
    proc.child.kill("SIGTERM");
    await proc.exited;
  });

  const post = (body, token = HTTP_TOKEN) => fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

  it("serves /health without auth", async () => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });

  it("requires the bearer token", async () => {
    assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, null)).status, 401);
    assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, "wrong-token-wrong-token")).status, 401);
    assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "ping" })).status, 200);
  });

  it("answers notifications with 202 and GET with 405", async () => {
    assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
    const get = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${HTTP_TOKEN}` } });
    assert.equal(get.status, 405);
  });

  it("calls a tool with the client secret read from a file, and logs without secrets", async () => {
    fake.reset();
    fake.handlers.set("/v1/rest/mgmt .show databases | project DatabaseName", v1([["DatabaseName", "string"]], [["Samples"]]));
    const response = await post({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "kusto_database_list", arguments: { "cluster-uri": fake.url } } });
    const body = await response.json();
    assert.deepEqual(JSON.parse(body.result.content[0].text).results, { databases: ["DatabaseName:string", '["Samples"]'] });
    assert.match(proc.stderr, /v1\/mgmt 200/);
    assert.doesNotMatch(proc.stderr, new RegExp(`${CLIENT_SECRET}|${HTTP_TOKEN}`));
  });

  const rawRequest = (port, text, { thenDestroy = false } = {}) => new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(text);
      if (thenDestroy) setTimeout(() => socket.destroy(), 50);
    });
    let data = "";
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("close", () => resolve(data));
    socket.on("error", () => resolve(data));
  });

  it("survives a malformed request target without the token", async () => {
    const port = Number(new URL(base).port);
    const answer = await rawRequest(port, "GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    assert.match(answer, /^HTTP\/1\.1 400/);
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });

  it("survives a client that drops the connection mid-body", async () => {
    const port = Number(new URL(base).port);
    await rawRequest(port, `POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${HTTP_TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 5000\r\n\r\n{"jsonrpc":`, { thenDestroy: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });

  it("answers a JSON-RPC response message with 202", async () => {
    assert.equal((await post({ jsonrpc: "2.0", id: 9, result: {} })).status, 202);
  });

  it("cancels the Kusto request when the client disconnects, and keeps serving", async () => {
    fake.reset();
    fake.handlers.set("T | take 1", { __delay: 1500, body: v1([["a", "int"]], [[1]]) });
    const controller = new AbortController();
    const pending = fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${HTTP_TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "kusto_query", arguments: { query: "T | take 1", database: "d", "cluster-uri": fake.url } } }),
      signal: controller.signal,
    }).catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    assert.equal((await pending).name, "AbortError");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.match(proc.stderr, /tool kusto_query error/);
    assert.equal(fake.requests.filter((request) => request.path === "/v1/rest/query").length, 1);
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });

  it("refuses to start in HTTP mode without a token", async () => {
    const bad = spawnServer({ MCP_TRANSPORT: "http", PORT: "0" });
    assert.equal(await bad.exited, 2);
    assert.match(bad.stderr, /requires MCP_HTTP_TOKEN/);
  });
});

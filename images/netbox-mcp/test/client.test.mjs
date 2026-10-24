import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { buildQuery, makeRedactor, NetBoxClient, normalizeBaseUrl, Semaphore, summarizeErrorBody } from "../src/netbox.mjs";
import { startFakeNetBox, TOKEN } from "./fake-netbox.mjs";

describe("query and URL helpers", () => {
  it("builds repeated, boolean, and null parameters", () => {
    assert.equal(buildQuery({ status: ["active", "planned"], cabled: true, vrf_id: null, skip: undefined, limit: 5 }),
      "?status=active&status=planned&cabled=true&vrf_id=null&limit=5");
    assert.equal(buildQuery({}), "");
  });

  it("normalizes the base URL and rejects credentials", () => {
    assert.equal(normalizeBaseUrl("https://nb.example/api/"), "https://nb.example");
    assert.equal(normalizeBaseUrl("https://nb.example/"), "https://nb.example");
    assert.equal(normalizeBaseUrl(undefined), undefined);
    assert.throws(() => normalizeBaseUrl("https://u:p@nb.example"), /credentials/);
    assert.throws(() => normalizeBaseUrl("ftp://nb.example"), /http/);
  });

  it("summarizes validation bodies concisely", () => {
    assert.equal(summarizeErrorBody({ detail: "Not found." }), "Not found.");
    assert.equal(summarizeErrorBody([{}, { slug: ["exists"] }]), "{\"[1]\":{\"slug\":[\"exists\"]}}");
    assert.equal(summarizeErrorBody("<html><b>Bad</b> gateway</html>"), "Bad gateway");
  });

  it("redacts the token and token-like strings", () => {
    const redact = makeRedactor("supersecretvalue");
    assert.equal(redact("x supersecretvalue y"), "x [REDACTED] y");
    assert.equal(redact("nbt_abc.def123"), "nbt_[REDACTED]");
    assert.equal(redact("Authorization: Bearer abcdefghijkl"), "Authorization: Bearer [REDACTED]");
  });

  it("semaphore caps concurrency", async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 8 }, () => semaphore.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    })));
    assert.equal(peak, 2);
  });
});

describe("NetBoxClient against a fake NetBox", () => {
  let fake;
  before(async () => {
    fake = await startFakeNetBox();
  });
  after(async () => {
    await fake.close();
  });
  const client = (options = {}) => new NetBoxClient({ url: fake.url, token: TOKEN, retryBaseMs: 1, retryMaxMs: 5, ...options });

  it("sends a Bearer token for nbt_ tokens", async () => {
    fake.reset();
    await client().get("/api/status/");
    assert.equal(fake.state.requests[0].headers.authorization, `Bearer ${TOKEN}`);
  });

  it("honours the concurrency limit", async () => {
    fake.reset();
    fake.state.delayMs = 20;
    const nb = client({ maxConcurrency: 3 });
    await Promise.all(Array.from({ length: 12 }, () => nb.get("/api/status/")));
    fake.state.delayMs = 0;
    assert.equal(fake.state.requests.length, 12);
    assert.ok(fake.state.maxInflight <= 3, `peak ${fake.state.maxInflight}`);
    assert.equal(fake.state.maxInflight, 3);
  });

  it("retries GET on 502/503/504 and then succeeds", async () => {
    fake.reset();
    let calls = 0;
    fake.route("GET", "/api/dcim/sites/", () => {
      calls += 1;
      return calls < 3 ? { status: [502, 503][calls - 1], body: "<html>down</html>" } : { body: { count: 0, results: [] } };
    });
    const nb = client();
    const { data } = await nb.get("/api/dcim/sites/");
    assert.equal(data.count, 0);
    assert.equal(calls, 3);
    assert.equal(nb.stats.retries, 2);
  });

  it("gives up after the retry budget", async () => {
    fake.reset();
    fake.route("GET", "/api/dcim/sites/", () => ({ status: 504, body: { detail: "timeout" } }));
    await assert.rejects(client({ retries: 2 }).get("/api/dcim/sites/"), /HTTP 504: timeout/);
    assert.equal(fake.state.requests.length, 3);
  });

  it("never retries POST, PATCH, or DELETE", async () => {
    for (const method of ["POST", "PATCH", "DELETE"]) {
      fake.reset();
      fake.route(method, "/api/dcim/sites/", () => ({ status: 503, body: { detail: "busy" } }));
      await assert.rejects(client().request(method, "/api/dcim/sites/", { body: [] }), /not retried.*may have been applied.*get_changelog since="/);
      assert.equal(fake.state.requests.length, 1, method);
    }
  });

  it("retries read-only POST when asked", async () => {
    fake.reset();
    let calls = 0;
    fake.route("POST", "/graphql/", () => (++calls === 1 ? { status: 503 } : { body: { data: {} } }));
    await client().request("POST", "/graphql/", { body: { query: "{x}" }, retry: true });
    assert.equal(calls, 2);
  });

  it("retries GET on ECONNRESET", async () => {
    let calls = 0;
    const fetchImpl = async (...args) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      return fetch(...args);
    };
    await client({ fetchImpl }).get("/api/status/");
    assert.equal(calls, 2);
  });

  it("surfaces validation errors and redacts the token from every error", async () => {
    fake.reset();
    fake.route("POST", "/api/extras/tags/", (request) => ({
      status: 400,
      body: { slug: ["tag with this slug already exists."], echo: [`auth was ${request.headers.authorization}`] },
    }));
    const error = await client().request("POST", "/api/extras/tags/", { body: {} }).catch((e) => e);
    assert.match(error.message, /HTTP 400: .*slug already exists/);
    assert.equal(error.message.includes(TOKEN), false);
    assert.match(error.message, /\[REDACTED\]/);

    const failing = async () => { throw new Error(`boom ${TOKEN}`); };
    const network = await client({ fetchImpl: failing, retries: 0 }).get("/api/status/").catch((e) => e);
    assert.equal(network.message.includes(TOKEN), false);
  });

  it("refuses redirects and unexpected paths", async () => {
    fake.reset();
    fake.route("GET", "/api/dcim/sites/", () => ({ status: 302, headers: { Location: "https://evil.example/" } }));
    await assert.rejects(client().get("/api/dcim/sites/"), /redirect 302/);
    await assert.rejects(client().get("/admin/"), /unexpected path/);
    await assert.rejects(client().get("/api/../admin/"), /unexpected path/);
  });

  it("times out slow requests", async () => {
    fake.reset();
    fake.state.delayMs = 200;
    await assert.rejects(client({ timeoutMs: 20, retries: 0 }).get("/api/status/"), /timed out after 20 ms/);
    fake.state.delayMs = 0;
  });

  it("gives writes a longer timeout than reads", async () => {
    fake.reset();
    fake.state.delayMs = 80;
    const nb = client({ timeoutMs: 20, writeTimeoutMs: 2_000, retries: 0 });
    assert.equal(new NetBoxClient().writeTimeoutMs, 120_000);
    assert.equal(new NetBoxClient().timeoutMs, 30_000);
    await assert.rejects(nb.get("/api/dcim/sites/"), /timed out after 20 ms/);
    const { status } = await nb.request("DELETE", "/api/dcim/sites/", { body: [] });
    assert.equal(status, 204);
    fake.state.delayMs = 0;
  });

  it("says a timed-out write may have been applied and never retries it", async () => {
    fake.reset();
    fake.state.delayMs = 200;
    const before = new Date().toISOString();
    const error = await client({ writeTimeoutMs: 20 }).request("DELETE", "/api/dcim/devices/", { body: [{ id: 1 }] }).catch((e) => e);
    fake.state.delayMs = 0;
    assert.match(error.message, /DELETE \/api\/dcim\/devices\/ failed: timed out after 20 ms/);
    assert.match(error.message, /may have been applied/);
    const since = /get_changelog since="([^"]+)"/.exec(error.message)?.[1];
    assert.ok(since && since >= before && !Number.isNaN(Date.parse(since)), since);
    assert.equal(error.startedAt, since);
    assert.equal(error.outcomeUnknown, true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(fake.state.requests.length, 1);
  });

  it("does not flag a write that never reached NetBox", async () => {
    const refused = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); };
    const error = await client({ fetchImpl: refused }).request("POST", "/api/dcim/sites/", { body: {} }).catch((e) => e);
    assert.equal(error.outcomeUnknown, false);
    assert.doesNotMatch(error.message, /may have been applied/);
  });

  it("requires URL and token before any request", async () => {
    await assert.rejects(new NetBoxClient({ token: TOKEN }).get("/api/status/"), /NETBOX_URL is not set/);
    await assert.rejects(new NetBoxClient({ url: fake.url }).get("/api/status/"), /NETBOX_TOKEN/);
  });
});

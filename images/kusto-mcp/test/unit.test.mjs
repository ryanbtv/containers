import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseResourceId, resolveSubscriptionOption, toClusterModel } from "../src/arm.mjs";
import { TokenProvider } from "../src/auth.mjs";
import { fetchWithRetry, Limiter } from "../src/http.mjs";
import { isKustoHost, kustoScope, normalizeClusterUri, parseExact, parseV2, toItems, toObjects, toStringList } from "../src/kusto.mjs";
import { makeRedactor } from "../src/mcp.mjs";

describe("cluster URIs", () => {
  it("accepts Kusto hosts and normalizes the trailing slash", () => {
    assert.equal(normalizeClusterUri("https://help.kusto.windows.net/"), "https://help.kusto.windows.net");
    assert.equal(normalizeClusterUri("https://mycluster.westus2.kusto.windows.net"), "https://mycluster.westus2.kusto.windows.net");
    assert.equal(normalizeClusterUri("https://trd-abc.z1.kusto.fabric.microsoft.com"), "https://trd-abc.z1.kusto.fabric.microsoft.com");
    assert.equal(normalizeClusterUri("https://ade.loganalytics.io/subscriptions/s/resourcegroups/r/providers/microsoft.operationalinsights/workspaces/w"), "https://ade.loganalytics.io/subscriptions/s/resourcegroups/r/providers/microsoft.operationalinsights/workspaces/w");
  });

  it("refuses other hosts, http, and lookalikes", () => {
    assert.throws(() => normalizeClusterUri("http://help.kusto.windows.net"), /HTTPS/);
    assert.throws(() => normalizeClusterUri("https://kusto.windows.net"), /Received host/);
    assert.throws(() => normalizeClusterUri("https://evil.com/.kusto.windows.net"), /Received host: 'evil.com'/);
    assert.throws(() => normalizeClusterUri("https://a_b.kusto.windows.net"), /Received host/);
    assert.throws(() => normalizeClusterUri("https://user:pw@help.kusto.windows.net"), /credentials/);
    assert.throws(() => normalizeClusterUri("not a url"), /Invalid Kusto cluster URI format/);
    assert.throws(() => normalizeClusterUri(""), /cannot be an empty string or composed entirely of whitespace\. \(Parameter 'clusterUri'\)/);
    assert.throws(() => normalizeClusterUri("https://evil.com"), (error) => error.name === "ArgumentException" && /\(Parameter 'clusterUri'\)$/.test(error.message));
  });

  it("enforces an exact cluster allowlist when given", () => {
    const allowedClusters = ["https://mine.westus2.kusto.windows.net"];
    assert.equal(normalizeClusterUri("https://MINE.westus2.kusto.windows.net/", { allowedClusters }), "https://mine.westus2.kusto.windows.net");
    assert.throws(() => normalizeClusterUri("https://theirs.westus2.kusto.windows.net", { allowedClusters }), /KUSTO_ALLOWED_CLUSTERS/);
  });

  it("honors extra suffixes and hosts", () => {
    assert.equal(isKustoHost("x.example.net", [".example.net"]), true);
    assert.equal(isKustoHost("kusto.local", [], ["kusto.local"]), true);
  });

  it("picks the token scope by cloud", () => {
    assert.equal(kustoScope("https://a.kusto.windows.net"), "https://kusto.kusto.windows.net/.default");
    assert.equal(kustoScope("https://a.kusto.chinacloudapi.cn"), "https://kusto.kusto.chinacloudapi.cn/.default");
    assert.equal(kustoScope("https://a.kusto.usgovcloudapi.net"), "https://kusto.kusto.usgovcloudapi.net/.default");
  });
});

describe("result shaping", () => {
  const result = { Tables: [{ TableName: "Table_0", Columns: [{ ColumnName: "a", ColumnType: "int" }, { ColumnName: "b", ColumnType: "string" }], Rows: [[1, "x"], [2, null]] }] };
  it("matches azure-mcp's string list and item list", () => {
    assert.deepEqual(toStringList(result), ["a:int,b:string", '[1,"x"]', "[2,null]"]);
    assert.deepEqual(toItems(result), [{ a: "int", b: "string" }, [1, "x"], [2, null]]);
    assert.deepEqual(toObjects(result), [{ a: 1, b: "x" }, { a: 2, b: null }]);
    assert.deepEqual(toStringList({}), []);
    assert.deepEqual(toItems(null), []);
  });

  it("keeps the exact text of numbers a JS number would change", () => {
    const parsed = parseExact('{"Rows":[[9007199254740993,1.0E-7,1.50,42,-0.5,"9007199254740993"]]}');
    assert.equal(JSON.stringify(parsed), '{"Rows":[[9007199254740993,1.0E-7,1.50,42,-0.5,"9007199254740993"]]}');
    assert.equal(toStringList({ Tables: [{ Columns: [{ ColumnName: "id", ColumnType: "long" }], Rows: parsed.Rows }] })[1], '[9007199254740993,1.0E-7,1.50,42,-0.5,"9007199254740993"]');
  });

  it("shapes 200k rows without overflowing the stack", () => {
    const rows = Array.from({ length: 200_000 }, (_, index) => [index]);
    const result = { Tables: [{ Columns: [{ ColumnName: "a", ColumnType: "int" }], Rows: rows }] };
    assert.equal(toItems(result).length, 200_001);
    const { tables } = parseV2([{ FrameType: "TableHeader", TableId: 1, TableKind: "PrimaryResult", Columns: [] }, { FrameType: "TableFragment", TableId: 1, TableFragmentType: "DataAppend", Rows: rows }, { FrameType: "DataSetCompletion", HasErrors: false }]);
    assert.equal(tables[0].rows.length, 200_000);
  });

  it("reports a v2 response without DataSetCompletion as incomplete", () => {
    const { completion } = parseV2([{ FrameType: "DataTable", TableId: 1, TableKind: "PrimaryResult", Columns: [], Rows: [[1]] }]);
    assert.equal(completion.complete, false);
    assert.equal(completion.hasErrors, true);
  });

  it("handles DataReplace fragments", () => {
    const { tables } = parseV2([
      { FrameType: "TableHeader", TableId: 1, TableKind: "PrimaryResult", TableName: "P", Columns: [] },
      { FrameType: "TableFragment", TableId: 1, TableFragmentType: "DataAppend", Rows: [[1]] },
      { FrameType: "TableFragment", TableId: 1, TableFragmentType: "DataReplace", Rows: [[9]] },
    ]);
    assert.deepEqual(tables[0].rows, [[9]]);
  });
});

describe("ARM helpers", () => {
  it("parses resource ids and maps the cluster model", () => {
    assert.deepEqual(parseResourceId("/subscriptions/S/resourceGroups/RG/providers/Microsoft.Kusto/clusters/c"), { subscriptionId: "S", resourceGroup: "RG" });
    const model = toClusterModel({ id: "/subscriptions/S/resourceGroups/RG/providers/x/c", name: "c" });
    assert.equal(model.resourceGroup, "RG");
    assert.equal(model.zones, "");
    assert.equal(model.isAutoStopEnabled, false);
    assert.throws(() => toClusterModel({}), /Resource ID is missing/);
  });

  it("treats placeholders as the default subscription", () => {
    assert.equal(resolveSubscriptionOption("<subscription-id>", "def"), "def");
    assert.equal(resolveSubscriptionOption("'abc'", "def"), "abc");
    assert.equal(resolveSubscriptionOption(undefined, "def"), "def");
    assert.equal(resolveSubscriptionOption(undefined, undefined), undefined);
  });
});

describe("tokens", () => {
  it("refreshes five minutes before expiry and dedupes concurrent requests", async () => {
    let now = 0;
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return new Response(JSON.stringify({ access_token: `t${calls}`, expires_in: 600 }), { status: 200 });
    };
    const provider = new TokenProvider({ tenantId: "t", clientId: "c", clientSecret: "s", fetch: fetchImpl, now: () => now });
    // expires_in 600 s: refresh at 300 s (five minutes early).
    const [a, b] = await Promise.all([provider.token("scope"), provider.token("scope")]);
    assert.equal(a, "t1");
    assert.equal(b, "t1");
    now = 299_000;
    assert.equal(await provider.token("scope"), "t1");
    now = 301_000;
    assert.equal(await provider.token("scope"), "t2");
    assert.equal(calls, 2);
  });

  it("refuses when unconfigured", async () => {
    await assert.rejects(new TokenProvider({}).token("s"), /not configured/);
  });
});

describe("HTTP helpers", () => {
  it("limits concurrency", async () => {
    const limiter = new Limiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 6 }, () => limiter.run(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    })));
    assert.equal(peak, 2);
  });

  it("retries connection errors only when allowed", async () => {
    let calls = 0;
    const failing = async () => {
      calls++;
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    };
    await assert.rejects(fetchWithRetry(failing, "https://x.kusto.windows.net/", {}, { retries: 0 }), /ECONNRESET/);
    assert.equal(calls, 1);
    await assert.rejects(fetchWithRetry(failing, "https://x.kusto.windows.net/", {}, { retries: 2, sleepImpl: async () => {} }), /ECONNRESET/);
    assert.equal(calls, 4);
  });

  it("never retries a timeout, and refuses redirects", async () => {
    let calls = 0;
    let redirect;
    const timingOut = async (url, init) => {
      calls++;
      redirect = init.redirect;
      throw Object.assign(new DOMException("timed out", "TimeoutError"));
    };
    await assert.rejects(fetchWithRetry(timingOut, "https://x.kusto.windows.net/", {}, { retries: 3, sleepImpl: async () => {} }), (error) => error.status === 504 && /timed out/.test(error.message));
    assert.equal(calls, 1);
    assert.equal(redirect, "error");
  });

  it("retries 429 and 503 but not 502 or 504", async () => {
    for (const [status, expected] of [[429, 2], [503, 2], [502, 1], [504, 1]]) {
      let calls = 0;
      const once = async () => {
        calls++;
        return new Response("{}", { status: calls === 1 ? status : 200 });
      };
      await fetchWithRetry(once, "https://x.kusto.windows.net/", {}, { retries: 2, sleepImpl: async () => {} });
      assert.equal(calls, expected, String(status));
    }
  });

  it("stops at once when the caller cancels", async () => {
    const controller = new AbortController();
    controller.abort();
    const never = async (url, init) => {
      throw init.signal.reason ?? new Error("aborted");
    };
    await assert.rejects(fetchWithRetry(never, "https://x.kusto.windows.net/", {}, { retries: 3, signal: controller.signal, sleepImpl: async () => {} }), (error) => error.status === 499);
  });

  it("redacts secrets and bearer tokens", () => {
    const redact = makeRedactor("supersecret");
    assert.equal(redact("x supersecret y Bearer abcdefghijkl"), "x [REDACTED] y Bearer [REDACTED]");
  });
});

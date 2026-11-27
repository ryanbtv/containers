import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { clusterResource, startFakeAzure, SUBSCRIPTION, TENANT, v1 } from "./fake-azure.mjs";
import { envelope, makeTools } from "./helpers.mjs";

let fake;
let uri;
before(async () => {
  fake = await startFakeAzure();
  uri = fake.url;
});
after(async () => fake.close());
beforeEach(() => fake.reset());

const kustoRequests = () => fake.requests.filter((request) => request.path.startsWith("/v"));

describe("compatible commands", () => {
  it("kusto_query validates, sends the azure-mcp request, and returns {items}", async () => {
    fake.handlers.set("/v1/rest/query StormEvents | where State == 'TEXAS' | take 2", v1([["State", "string"], ["Count", "long"]], [["TEXAS", 1], ["TEXAS", 2]]));
    const result = await makeTools(fake).call("kusto_query", { query: "StormEvents | where State == 'TEXAS' | take 2", database: "Samples", "cluster-uri": uri });
    assert.equal(result.isError, undefined);
    const body = envelope(result);
    assert.deepEqual(Object.keys(body), ["status", "message", "results", "duration"]);
    assert.equal(body.status, 200);
    assert.equal(body.message, "");
    assert.deepEqual(body.results, { items: [{ State: "string", Count: "long" }, ["TEXAS", 1], ["TEXAS", 2]] });
    const [request] = kustoRequests();
    assert.equal(request.body.db, "Samples");
    assert.match(request.body.properties.ClientRequestId, /^KustoMcp\.query;[0-9a-f-]{36}$/);
    assert.equal(request.headers["x-ms-client-request-id"], request.body.properties.ClientRequestId);
    assert.deepEqual(request.body.properties.Options, { request_readonly: true });
    assert.match(request.headers.authorization, new RegExp(`^Bearer tok-${TENANT}-https://kusto.kusto.windows.net/.default-`));
  });

  it("kusto_query refuses a management command without calling Kusto", async () => {
    const body = envelope(await makeTools(fake).call("kusto_query", { query: ".drop table T", database: "d", "cluster-uri": uri }));
    assert.equal(body.status, 400);
    assert.match(body.message, /Management command '\.drop' is not allowed/);
    assert.equal(body.results, undefined);
    assert.equal(kustoRequests().length, 0);
  });

  it("kusto_sample sends ['table'] | sample N with a clamped limit, and returns {results}", async () => {
    fake.handlers.set("['Storm Events'] | sample 10000", v1([["a", "int"]], [[1]]));
    fake.handlers.set("['Storm Events'] | sample 10", v1([["a", "int"]], [[2]]));
    const tools = makeTools(fake);
    const big = envelope(await tools.call("kusto_sample", { table: "Storm Events", database: "d", "cluster-uri": uri, limit: 99999 }));
    assert.deepEqual(big.results, { results: [{ a: "int" }, [1]] });
    const defaulted = envelope(await tools.call("kusto_sample", { table: "Storm Events", database: "d", "cluster-uri": uri, limit: null }));
    assert.deepEqual(defaulted.results, { results: [{ a: "int" }, [2]] });
  });

  it("kusto_database_list sends .show databases to NetDefaultDB over mgmt", async () => {
    fake.handlers.set("/v1/rest/mgmt .show databases | project DatabaseName", v1([["DatabaseName", "string"]], [["Samples"], ["Logs"]]));
    const body = envelope(await makeTools(fake).call("kusto_database_list", { "cluster-uri": `${uri}/` }));
    assert.deepEqual(body.results, { databases: ["DatabaseName:string", '["Samples"]', '["Logs"]'] });
    assert.equal(kustoRequests()[0].path, "/v1/rest/mgmt");
    assert.equal(kustoRequests()[0].body.db, "NetDefaultDB");
  });

  it("kusto_table_list returns azure-mcp's string list", async () => {
    fake.handlers.set("/v1/rest/mgmt .show tables", v1([["TableName", "string"], ["DatabaseName", "string"], ["Folder", "string"], ["DocString", "string"]], [["T", "d", "", ""]]));
    const body = envelope(await makeTools(fake).call("kusto_table_list", { database: "d", "cluster-uri": uri }));
    assert.deepEqual(body.results, { tables: ["TableName:string,DatabaseName:string,Folder:string,DocString:string", '["T","d","",""]'] });
  });

  it("kusto_table_schema runs cslschema on the query endpoint and joins lines", async () => {
    fake.handlers.set("/v1/rest/query .show table ['T'] cslschema", v1([["TableName", "string"], ["Schema", "string"]], [["T", "a:string,b:long"]]));
    const body = envelope(await makeTools(fake).call("kusto_table_schema", { table: "T", database: "d", "cluster-uri": uri }));
    assert.deepEqual(body.results, { schema: 'TableName:string,Schema:string\n["T","a:string,b:long"]' });
  });

  it("kusto_table_schema refuses an injected table name", async () => {
    const body = envelope(await makeTools(fake).call("kusto_table_schema", { table: "T | take 1", database: "d", "cluster-uri": uri }));
    assert.equal(body.status, 400);
    assert.match(body.message, /tableName contains invalid characters/);
  });

  it("kusto_cluster_list queries Resource Graph and returns names plus truncation", async () => {
    const tools = makeTools(fake);
    const all = envelope(await tools.call("kusto_cluster_list", {}));
    assert.deepEqual(all.results, { clusters: ["adx1", "adx2"], areResultsTruncated: false });
    const graph = fake.requests.find((request) => request.path.includes("ResourceGraph"));
    assert.equal(graph.query["api-version"], "2024-04-01");
    assert.deepEqual(graph.body.subscriptions, [SUBSCRIPTION]);
    assert.equal(graph.body.query, "resources | where type =~ 'Microsoft.Kusto/clusters' | limit 50");
    const filtered = envelope(await tools.call("kusto_cluster_list", { "resource-group": "rg-other", subscription: "Main Sub" }));
    assert.deepEqual(filtered.results.clusters, ["adx2"]);
  });

  it("kusto_cluster_get returns azure-mcp's cluster model", async () => {
    const body = envelope(await makeTools(fake).call("kusto_cluster_get", { cluster: "ADX1" }));
    assert.deepEqual(body.results, {
      cluster: {
        name: "adx1",
        location: "westus2",
        resourceGroup: "rg-data",
        subscription: SUBSCRIPTION,
        sku: "Dev(No SLA)_Standard_E2a_v4",
        zones: "1,2",
        identity: "SystemAssigned",
        etag: "\"abc\"",
        state: "Running",
        provisioningState: "Succeeded",
        clusterUri: `${fake.url}/`,
        dataIngestionUri: "https://ingest-adx1.westus2.kusto.windows.net/",
        stateReason: null,
        isStreamingIngestEnabled: true,
        engineType: "V3",
        isAutoStopEnabled: true,
      },
    });
  });

  it("kusto_cluster_get maps a missing cluster to 404 with azure-mcp's message", async () => {
    const body = envelope(await makeTools(fake).call("kusto_cluster_get", { cluster: "nope" }));
    assert.equal(body.status, 404);
    assert.match(body.message, /^Kusto cluster not found\. Verify the cluster name, resource group, and that you have access\.\. To mitigate this issue, please refer to the troubleshooting guidelines here at https:\/\/aka\.ms\/azmcp\/troubleshooting\.$/);
    assert.deepEqual(body.results, { message: `Kusto cluster 'nope' not found for subscription '${SUBSCRIPTION}'.`, stackTrace: null, type: "KeyNotFoundException" });
  });

  it("--cluster plus --subscription resolves the cluster URI once and caches it", async () => {
    fake.handlers.set("/v1/rest/mgmt .show databases | project DatabaseName", v1([["DatabaseName", "string"]], [["x"]]));
    const tools = makeTools(fake);
    await tools.call("kusto_database_list", { cluster: "adx1", subscription: SUBSCRIPTION });
    await tools.call("kusto_database_list", { cluster: "adx1" });
    assert.equal(fake.requests.filter((request) => request.path.includes("ResourceGraph")).length, 1);
    assert.equal(kustoRequests().length, 2);
  });

  it("needs cluster-uri, or cluster and subscription", async () => {
    const tools = makeTools(fake, { config: { defaultSubscription: undefined } });
    tools.ctx.arm.defaultSubscription = undefined;
    const body = envelope(await tools.call("kusto_database_list", { cluster: "adx1" }));
    assert.equal(body.status, 400);
    assert.equal(body.message, "Either --cluster-uri must be provided, or both --subscription and --cluster must be provided.");
  });

  it("reports missing required options with azure-mcp's prefix", async () => {
    const body = envelope(await makeTools(fake).call("kusto_query", { "cluster-uri": uri }));
    assert.equal(body.message, "Missing Required options: --query, --database");
  });

  it("rejects unknown arguments with azure-mcp's plain text", async () => {
    const result = await makeTools(fake).call("kusto_query", { query: "T", database: "d", "cluster-uri": uri, extra: 1, other: 2 });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "Request rejected due to unknown arguments: extra, other");
  });

  it("matches option names like azure-mcp: any case, and camelCase without hyphens", async () => {
    fake.handlers.set("T | take 1", v1([["a", "int"]], [[1]]));
    const body = envelope(await makeTools(fake).call("kusto_query", { Query: "T | take 1", DATABASE: "d", clusterUri: uri }));
    assert.equal(body.status, 200);
    fake.handlers.set("/v1/rest/mgmt .show databases | project DatabaseName", v1([["DatabaseName", "string"]], [["x"]]));
    assert.equal(envelope(await makeTools(fake).call("kusto_database_list", { ClusterUri: uri })).status, 200);
  });

  it("converts values like azure-mcp: numbers to strings, numeric strings to integers", async () => {
    fake.handlers.set("['T'] | sample 5", v1([["a", "int"]], [[1]]));
    const tools = makeTools(fake);
    assert.equal(envelope(await tools.call("kusto_sample", { table: "T", database: "d", "cluster-uri": uri, limit: "5" })).status, 200);
    const bad = envelope(await tools.call("kusto_sample", { table: "T", database: "d", "cluster-uri": uri, limit: "five" }));
    assert.equal(bad.status, 400);
    assert.equal(bad.message, "Cannot parse argument 'five' for option '--limit' as expected type 'System.Nullable`1[System.Int32]'.");
    assert.match(envelope(await tools.call("kusto_sample", { table: "T", database: "d", "cluster-uri": uri, limit: 1e20 })).message, /as expected type 'System.Nullable`1\[System.Int32\]'/);
    assert.equal(envelope(await tools.call("kusto_command", { command: ".show tables", "cluster-uri": uri, "max-rows": 0 })).message, "--max-rows must be at least 1.");
    fake.handlers.set("/v1/rest/mgmt .show tables", v1([["TableName", "string"]], [["T"]]));
    assert.equal(envelope(await tools.call("kusto_table_list", { database: 12345, "cluster-uri": uri })).status, 200);
    assert.equal(kustoRequests().at(-1).body.db, "12345");
  });

  it("refuses a cluster URI outside the Kusto host allowlist", async () => {
    const tools = makeTools(fake, { kusto: { extraHosts: [] } });
    const body = envelope(await tools.call("kusto_database_list", { "cluster-uri": "https://evil.example.com" }));
    assert.equal(body.status, 400);
    assert.match(body.message, /Received host: 'evil.example.com'/);
    assert.equal(fake.requests.length, 0);
  });

  it("reports a Kusto error as azure-mcp does: 503 HttpRequestException", async () => {
    const body = envelope(await makeTools(fake).call("kusto_query", { query: "Bad syntax here", database: "d", "cluster-uri": uri }));
    assert.equal(body.status, 503);
    assert.match(body.message, /^Request failed with status code BadRequest: .*Syntax error.*\. To mitigate this issue/);
    assert.equal(body.results.type, "HttpRequestException");
  });

  it("additive tools keep Kusto's real status", async () => {
    const body = envelope(await makeTools(fake).call("kusto_command", { command: ".show nonsense", "cluster-uri": uri }));
    assert.equal(body.status, 400);
  });

  it("reports an invalid cluster URI as an ArgumentException with results", async () => {
    const body = envelope(await makeTools(fake, { kusto: { extraHosts: [] } }).call("kusto_table_list", { database: "d", "cluster-uri": "https://evil.example.com" }));
    assert.equal(body.status, 400);
    assert.match(body.message, /Received host: 'evil\.example\.com' \(Parameter 'clusterUri'\)\. To mitigate this issue/);
    assert.equal(body.results.type, "ArgumentException");
  });

  it("blocks Resource Graph injection through the cluster name", async () => {
    const tools = makeTools(fake);
    const piped = envelope(await tools.call("kusto_cluster_get", { cluster: "x' | project id //" }));
    assert.equal(piped.status, 400);
    assert.match(piped.message, /^additionalFilter must not contain the pipe operator '\|' to prevent KQL injection\. \(Parameter 'additionalFilter'\)/);
    assert.equal(fake.requests.filter((request) => request.path.includes("ResourceGraph")).length, 0);
    await tools.call("kusto_cluster_get", { cluster: "x\\' or 1==1 //" });
    const graph = fake.requests.find((request) => request.path.includes("ResourceGraph"));
    assert.equal(graph.body.query, "resources | where type =~ 'Microsoft.Kusto/clusters' and name =~ 'x\\\\'' or 1==1 //' | limit 1");
  });

  it("reports a missing resource group as 404, as azure-mcp does", async () => {
    const tools = makeTools(fake);
    const missing = envelope(await tools.call("kusto_cluster_list", { "resource-group": "rg-nope" }));
    assert.equal(missing.status, 404);
    assert.match(missing.message, /^Resource group 'rg-nope' does not exist in subscription '/);
    const empty = envelope(await tools.call("kusto_cluster_list", { "resource-group": "rg-empty" }));
    assert.deepEqual(empty.results, { clusters: [], areResultsTruncated: false });
  });

  it("keeps long values exact", async () => {
    fake.handlers.set("T | take 1", () => ({ __status: 200, body: '{"Tables":[{"TableName":"Table_0","Columns":[{"ColumnName":"id","DataType":"Int64","ColumnType":"long"}],"Rows":[[9007199254740993]]}]}' }));
    const result = await makeTools(fake).call("kusto_query", { query: "T | take 1", database: "d", "cluster-uri": uri });
    assert.match(result.content[0].text, /"items":\[\{"id":"long"\},\[9007199254740993\]\]/);
  });

  it("retries a throttled read, then succeeds", async () => {
    fake.handlers.set("T | take 1", v1([["a", "int"]], [[1]]));
    fake.fail("/v1/rest/query", 429, 1, { headers: { "Retry-After": "0" } });
    const body = envelope(await makeTools(fake).call("kusto_query", { query: "T | take 1", database: "d", "cluster-uri": uri }));
    assert.equal(body.status, 200);
    assert.equal(kustoRequests().length, 2);
  });

  it("works the same through the router, with flat parameters only when no parameters object", async () => {
    fake.handlers.set("T | take 1", v1([["a", "int"]], [[1]]));
    const tools = makeTools(fake);
    const routed = envelope(await tools.call("kusto", { intent: "q", command: "kusto_query", parameters: { query: "T | take 1", database: "d", "cluster-uri": uri } }));
    const flat = envelope(await tools.call("kusto", { intent: "q", command: "KUSTO_QUERY", query: "T | take 1", database: "d", "cluster-uri": uri }));
    assert.deepEqual(routed.results, { items: [{ a: "int" }, [1]] });
    assert.deepEqual(flat.results, routed.results);
    // A parameters object wins; flat keys beside it are ignored, as in azure-mcp.
    const nested = envelope(await tools.call("kusto", { intent: "q", command: "kusto_query", Parameters: { query: "T | take 1", database: "d", "cluster-uri": uri }, database: "ignored" }));
    assert.equal(nested.status, 200);
    assert.equal(kustoRequests().at(-1).body.db, "d");
    // A non-object parameters falls back to the flat keys.
    const fallback = envelope(await tools.call("kusto", { intent: "q", command: "kusto_query", parameters: "x", query: "T | take 1", database: "d", "cluster-uri": uri }));
    assert.equal(fallback.status, 200);
  });

  it("the router adds the command spec when required options are missing", async () => {
    const result = await makeTools(fake).call("kusto", { intent: "q", command: "kusto_table_list", parameters: { "cluster-uri": uri } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Missing Required options: --database\n\n- Review the following command spec/);
    assert.match(result.content[0].text, /Command Spec:\n\{"command":"kusto_table_list","description":"List\/enumerate all tables/);
    assert.deepEqual(JSON.parse(result.content[1].text).status, 400);
  });
});

describe("router missing-options spec", () => {
  it("adds the spec when the subscription is missing, as azure-mcp's message check does", async () => {
    const tools = makeTools(fake, { config: { defaultSubscription: undefined } });
    tools.ctx.arm.defaultSubscription = undefined;
    const result = await tools.call("kusto", { intent: "q", command: "kusto_cluster_list" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Missing Required options: --subscription\n/);
    assert.match(result.content[0].text, /"command":"kusto_cluster_list"/);
  });
});

describe("tokens", () => {
  it("caches one token per tenant and scope", async () => {
    fake.handlers.set("T | take 1", v1([["a", "int"]], [[1]]));
    const tools = makeTools(fake);
    const before = fake.tokenCount;
    await Promise.all([1, 2, 3].map(() => tools.call("kusto_query", { query: "T | take 1", database: "d", "cluster-uri": uri })));
    await tools.call("kusto_cluster_list", {});
    await tools.call("kusto_cluster_list", {});
    assert.equal(fake.tokenCount - before, 2); // one Kusto scope, one ARM scope
  });

  it("reports a bad client secret as an MSAL error", async () => {
    const tools = makeTools(fake);
    tools.ctx.kusto.tokens.clientSecret = "wrong";
    const body = envelope(await tools.call("kusto_query", { query: "T", database: "d", "cluster-uri": uri }));
    assert.equal(body.status, 401);
    assert.match(body.message, /invalid_client.*AADSTS7000215/);
    assert.equal(body.results.type, "MsalServiceException");
    assert.doesNotMatch(JSON.stringify(body), /wrong/);
  });
});

describe("additive read commands", () => {
  it("kusto_query_v2 sends v2 options, parameters, and readonly, and shapes tables", async () => {
    fake.handlers.set("/v2/rest/query declare query_parameters(n:long); T | take n", [
      { FrameType: "DataSetHeader", Version: "v2.0", IsProgressive: false },
      { FrameType: "DataTable", TableId: 0, TableKind: "QueryProperties", TableName: "@ExtendedProperties", Columns: [{ ColumnName: "Value", ColumnType: "dynamic" }], Rows: [[{}]] },
      { FrameType: "DataTable", TableId: 1, TableKind: "PrimaryResult", TableName: "PrimaryResult", Columns: [{ ColumnName: "a", ColumnType: "long" }], Rows: [[1], [2], [3]] },
      { FrameType: "DataSetCompletion", HasErrors: false, Cancelled: false },
    ]);
    const body = envelope(await makeTools(fake).call("kusto_query_v2", {
      query: "declare query_parameters(n:long); T | take n",
      database: "d",
      "cluster-uri": uri,
      "query-parameters": { n: 3, flag: true },
      options: { servertimeout: "00:01:00", truncationmaxrecords: 10 },
      "max-rows": 2,
    }));
    assert.equal(body.status, 200);
    assert.deepEqual(body.results.tables, [{ name: "PrimaryResult", kind: "PrimaryResult", columns: [{ name: "a", type: "long" }], rows: [[1], [2]], rowCount: 3, truncated: true }]);
    const [request] = kustoRequests();
    assert.equal(request.path, "/v2/rest/query");
    assert.deepEqual(request.body.properties.Options, { results_progressive_enabled: false, servertimeout: "00:01:00", truncationmaxrecords: 10, request_readonly: true });
    assert.deepEqual(request.body.properties.Parameters, { n: 3, flag: "true" });
  });

  it("kusto_query_v2 parses progressive frames without FrameType and reports errors", async () => {
    fake.handlers.set("T", [
      { Version: "v2.0", IsProgressive: true },
      { TableId: 1, TableKind: "PrimaryResult", TableName: "PrimaryResult", Columns: [{ ColumnName: "a", ColumnType: "int" }] },
      { TableId: 1, TableFragmentType: "DataAppend", Rows: [[1]] },
      { TableId: 1, TableFragmentType: "DataAppend", Rows: [[2]] },
      { TableId: 1, RowCount: 2 },
      { HasErrors: true, Cancelled: false, OneApiErrors: [{ error: { code: "LimitsExceeded" } }] },
    ]);
    const body = envelope(await makeTools(fake).call("kusto_query_v2", { query: "T", database: "d", "cluster-uri": uri }));
    assert.equal(body.status, 206);
    assert.deepEqual(body.results.tables[0].rows, [[1], [2]]);
    assert.equal(body.results.hasErrors, true);
    assert.deepEqual(body.results.errors, [{ error: { code: "LimitsExceeded" } }]);
  });

  it("kusto_query_v2 refuses unsafe options and management commands", async () => {
    const tools = makeTools(fake);
    assert.match(envelope(await tools.call("kusto_query_v2", { query: "T", database: "d", "cluster-uri": uri, options: { request_readonly: false } })).message, /options\.request_readonly is not an allowed client request property/);
    assert.match(envelope(await tools.call("kusto_query_v2", { query: ".drop table T", database: "d", "cluster-uri": uri })).message, /not allowed/);
    assert.equal(kustoRequests().length, 0);
  });

  it("kusto_command and kusto_query_v2 stay read-only with KUSTO_QUERY_READONLY=0", async () => {
    fake.handlers.set("/v1/rest/mgmt .show tables", v1([["TableName", "string"]], [["T"]]));
    fake.handlers.set("/v2/rest/query T", [{ FrameType: "DataSetCompletion", HasErrors: false, Cancelled: false }]);
    fake.handlers.set("/v1/rest/query T | take 1", v1([["a", "int"]], [[1]]));
    const tools = makeTools(fake, { config: { queryReadOnly: false } });
    await tools.call("kusto_command", { command: ".show tables", "cluster-uri": uri });
    await tools.call("kusto_query_v2", { query: "T", database: "d", "cluster-uri": uri });
    await tools.call("kusto_query", { query: "T | take 1", database: "d", "cluster-uri": uri });
    const [command, v2, compat] = kustoRequests();
    assert.equal(command.body.properties.Options.request_readonly, true);
    assert.equal(v2.body.properties.Options.request_readonly, true);
    assert.equal(compat.body.properties.Options, undefined);
  });

  it("kusto_query_v2 reports a response without DataSetCompletion as an error", async () => {
    fake.handlers.set("/v2/rest/query T", [{ FrameType: "DataTable", TableId: 1, TableKind: "PrimaryResult", TableName: "P", Columns: [], Rows: [[1]] }]);
    const body = envelope(await makeTools(fake).call("kusto_query_v2", { query: "T", database: "d", "cluster-uri": uri }));
    assert.equal(body.status, 500);
    assert.match(body.message, /incomplete/);
  });

  it("kusto_command runs a .show command and refuses others", async () => {
    fake.handlers.set("/v1/rest/mgmt .show queries | take 1", v1([["ClientActivityId", "string"], ["State", "string"]], [["id-1", "Completed"]]));
    const tools = makeTools(fake);
    const body = envelope(await tools.call("kusto_command", { command: ".show queries | take 1", "cluster-uri": uri }));
    assert.deepEqual(body.results, { tables: [{ name: "Table_0", columns: [{ name: "ClientActivityId", type: "string" }, { name: "State", type: "string" }], rows: [["id-1", "Completed"]], rowCount: 1 }] });
    assert.equal(kustoRequests()[0].body.db, "NetDefaultDB");
    assert.deepEqual(kustoRequests()[0].body.properties.Options, { request_readonly: true });
    const refused = envelope(await tools.call("kusto_command", { command: ".drop table T", "cluster-uri": uri }));
    assert.equal(refused.status, 400);
  });

  it("kusto_database_schema parses the JSON schema and filters one table", async () => {
    const schema = { Databases: { Samples: { Name: "Samples", Tables: { StormEvents: { Name: "StormEvents", OrderedColumns: [{ Name: "State", Type: "System.String", CslType: "string" }] } }, Functions: {} } } };
    fake.handlers.set("/v1/rest/mgmt .show database ['Samples'] schema as json", v1([["DatabaseSchema", "string"]], [[JSON.stringify(schema)]]));
    const tools = makeTools(fake);
    const whole = envelope(await tools.call("kusto_database_schema", { database: "Samples", "cluster-uri": uri }));
    assert.equal(whole.results.schema.Name, "Samples");
    const one = envelope(await tools.call("kusto_database_schema", { database: "Samples", table: "stormevents", "cluster-uri": uri }));
    assert.deepEqual(one.results.schema.OrderedColumns, [{ Name: "State", Type: "System.String", CslType: "string" }]);
    const missing = envelope(await tools.call("kusto_database_schema", { database: "Samples", table: "Nope", "cluster-uri": uri }));
    assert.equal(missing.status, 404);
  });

  it("kusto_function_list and kusto_function_get", async () => {
    const columns = [["Name", "string"], ["Parameters", "string"], ["Body", "string"], ["Folder", "string"], ["DocString", "string"]];
    fake.handlers.set("/v1/rest/mgmt .show functions", v1(columns, [["F", "(x:long)", "{ T | take x }", "util", "doc"]]));
    fake.handlers.set("/v1/rest/mgmt .show function ['F']", v1(columns, [["F", "(x:long)", "{ T | take x }", "util", "doc"]]));
    const tools = makeTools(fake);
    assert.deepEqual(envelope(await tools.call("kusto_function_list", { database: "d", "cluster-uri": uri })).results, { functions: [{ name: "F", parameters: "(x:long)", folder: "util", docString: "doc" }] });
    assert.deepEqual(envelope(await tools.call("kusto_function_get", { function: "F", database: "d", "cluster-uri": uri })).results.function.body, "{ T | take x }");
  });

  it("kusto_principal_details parses current_principal_details()", async () => {
    fake.handlers.set("/v1/rest/query print details=current_principal_details()", v1([["details", "dynamic"]], [['{"Type":"AadApplication","DisplayName":"azure-mcp"}']]));
    const body = envelope(await makeTools(fake).call("kusto_principal_details", { database: "d", "cluster-uri": uri }));
    assert.deepEqual(body.results, { principal: { Type: "AadApplication", DisplayName: "azure-mcp" } });
  });
});

describe("write commands", () => {
  const writes = () => makeTools(fake, { config: { enableWrites: true } });

  it("kusto_command_write needs confirm and is never retried", async () => {
    const tools = writes();
    const unconfirmed = envelope(await tools.call("kusto_command_write", { command: ".create table T (a:int)", confirm: false, "cluster-uri": uri }));
    assert.equal(unconfirmed.status, 400);
    assert.equal(kustoRequests().length, 0);
    fake.fail("/v1/rest/mgmt", 503, 1);
    const failed = envelope(await tools.call("kusto_command_write", { command: ".create table T (a:int)", confirm: true, database: "d", "cluster-uri": uri }));
    assert.equal(failed.status, 503);
    assert.equal(kustoRequests().length, 1);
    assert.equal(kustoRequests()[0].body.properties.Options, undefined);
  });

  it("kusto_command_write runs the command against the named database", async () => {
    fake.handlers.set("/v1/rest/mgmt .create table T (a:int)", v1([["TableName", "string"]], [["T"]]));
    const body = envelope(await writes().call("kusto_command_write", { command: ".create table T (a:int)", confirm: true, database: "d", "cluster-uri": uri }));
    assert.equal(body.status, 200);
    assert.equal(kustoRequests()[0].body.db, "d");
  });

  it("kusto_query_cancel builds a quoted .cancel query command", async () => {
    fake.handlers.set('/v1/rest/mgmt .cancel query "KD2RunQuery;abc" with (reason="too slow")', v1([["RunningQueryCanceled", "bool"]], [[true]]));
    const tools = writes();
    const body = envelope(await tools.call("kusto_query_cancel", { "client-request-id": "KD2RunQuery;abc", reason: "too slow", "cluster-uri": uri }));
    assert.equal(body.status, 200);
    assert.match(envelope(await tools.call("kusto_query_cancel", { "client-request-id": 'x" | .drop', "cluster-uri": uri })).message, /may contain only/);
  });

  it("kusto_ingest_stream accepts data over 1,000,000 characters up to the byte cap", async () => {
    const tools = writes();
    const data = "a\n".repeat(600_000);
    const body = envelope(await tools.call("kusto_ingest_stream", { database: "d", table: "T", format: "csv", data, confirm: true, "cluster-uri": uri }));
    assert.equal(body.status, 200);
    assert.equal(body.results.bytes, 1_200_000);
  });

  it("kusto_ingest_stream posts the data to /v1/rest/ingest with the format", async () => {
    const tools = writes();
    const body = envelope(await tools.call("kusto_ingest_stream", { database: "d", table: "T", format: "csv", data: "1,a\n2,b\n", confirm: true, "cluster-uri": uri }));
    assert.equal(body.status, 200);
    assert.equal(body.results.bytes, 8);
    const [request] = kustoRequests();
    assert.equal(request.path, "/v1/rest/ingest/d/T");
    assert.deepEqual(request.query, { streamFormat: "csv" });
    assert.equal(request.raw, "1,a\n2,b\n");
    assert.match(envelope(await tools.call("kusto_ingest_stream", { database: "d", table: "T", format: "json", data: "{}", confirm: true, "cluster-uri": uri })).message, /--mapping-name/);
    const missing = envelope(await tools.call("kusto_ingest_stream", { database: "d", table: "Missing", format: "csv", data: "1", confirm: true, "cluster-uri": uri }));
    assert.equal(missing.status, 404);
  });
});

describe("cluster helpers", () => {
  it("clusterResource keeps the ARM shape the model reads", () => {
    const item = clusterResource("x", { uri: "https://x.kusto.windows.net" });
    assert.equal(item.properties.uri, "https://x.kusto.windows.net");
  });
});

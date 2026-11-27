// In-process fake of the three services kusto-mcp talks to: the Entra ID token
// endpoint, Azure Resource Manager (subscriptions and Resource Graph), and a
// Kusto cluster's REST API. One HTTP server on 127.0.0.1 plays all three.
import { createServer } from "node:http";

export const TENANT = "11111111-1111-1111-1111-111111111111";
export const CLIENT_ID = "22222222-2222-2222-2222-222222222222";
export const CLIENT_SECRET = "fake-client-secret-value";
export const SUBSCRIPTION = "33333333-3333-3333-3333-333333333333";

export function v1(columns, rows, name = "Table_0") {
  return { Tables: [{ TableName: name, Columns: columns.map(([ColumnName, ColumnType]) => ({ ColumnName, DataType: ColumnType === "string" ? "String" : ColumnType, ColumnType })), Rows: rows }] };
}

export function clusterResource(name, { rg = "rg-data", uri } = {}) {
  return {
    id: `/subscriptions/${SUBSCRIPTION}/resourceGroups/${rg}/providers/Microsoft.Kusto/clusters/${name}`,
    name,
    type: "microsoft.kusto/clusters",
    location: "westus2",
    resourceGroup: rg.toLowerCase(),
    subscriptionId: SUBSCRIPTION,
    sku: { name: "Dev(No SLA)_Standard_E2a_v4", tier: "Basic", capacity: 1 },
    zones: ["1", "2"],
    identity: { type: "SystemAssigned" },
    etag: "\"abc\"",
    properties: {
      state: "Running",
      provisioningState: "Succeeded",
      uri: uri ?? `https://${name}.westus2.kusto.windows.net`,
      dataIngestionUri: `https://ingest-${name}.westus2.kusto.windows.net`,
      enableStreamingIngest: true,
      engineType: "V3",
      enableAutoStop: true,
    },
  };
}

export async function startFakeAzure() {
  const requests = [];
  const handlers = new Map(); // csl -> (body) => {status, body} | object
  const failures = []; // queue of {path, status, times, headers}
  let tokenCount = 0;
  const clusters = [clusterResource("adx1"), clusterResource("adx2", { rg: "rg-other" })];

  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url, "http://127.0.0.1");
    const entry = { method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: request.headers, raw };
    try {
      entry.body = request.headers["content-type"]?.includes("json") ? JSON.parse(raw) : raw;
    } catch {
      entry.body = raw;
    }
    requests.push(entry);
    const send = (status, body, headers = {}) => {
      response.writeHead(status, { "Content-Type": "application/json", ...headers });
      response.end(typeof body === "string" ? body : JSON.stringify(body));
    };

    const failure = failures.find((item) => url.pathname.startsWith(item.path) && item.times > 0);
    if (failure) {
      failure.times--;
      return send(failure.status, failure.body ?? { error: { code: "Throttled", message: "slow down", "@message": "slow down" } }, failure.headers);
    }

    // Entra ID token endpoint.
    const token = /^\/([^/]+)\/oauth2\/v2\.0\/token$/.exec(url.pathname);
    if (token) {
      const form = new URLSearchParams(raw);
      if (form.get("client_secret") !== CLIENT_SECRET || form.get("client_id") !== CLIENT_ID) {
        return send(401, { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided.\r\nTrace ID: x", correlation_id: "corr-1" });
      }
      tokenCount++;
      return send(200, { token_type: "Bearer", expires_in: 3599, access_token: `tok-${decodeURIComponent(token[1])}-${form.get("scope")}-${tokenCount}` });
    }

    const auth = request.headers.authorization ?? "";
    if (!/^Bearer tok-/.test(auth)) return send(401, { error: { code: "Unauthorized", message: "no token" } });

    // Azure Resource Manager.
    if (url.pathname === "/subscriptions" && request.method === "GET") {
      return send(200, { value: [{ subscriptionId: SUBSCRIPTION, displayName: "Main Sub" }] });
    }
    const rgMatch = /^\/subscriptions\/[^/]+\/resourcegroups\/([^/]+)$/i.exec(url.pathname);
    if (rgMatch) {
      const name = decodeURIComponent(rgMatch[1]).toLowerCase();
      if (["rg-data", "rg-other", "rg-empty"].includes(name)) return send(200, { id: url.pathname, name });
      return send(404, { error: { code: "ResourceGroupNotFound", message: `Resource group '${name}' could not be found.` } });
    }
    if (url.pathname === "/providers/Microsoft.ResourceGraph/resources" && request.method === "POST") {
      const query = entry.body.query;
      let data = clusters;
      const name = /name =~ '([^']*)'/.exec(query)?.[1];
      const rg = /resourceGroup =~ '([^']*)'/.exec(query)?.[1];
      if (name) data = data.filter((item) => item.name.toLowerCase() === name.toLowerCase());
      if (rg) data = data.filter((item) => item.resourceGroup === rg.toLowerCase());
      return send(200, { totalRecords: data.length, count: data.length, data, resultTruncated: "false" });
    }

    // Kusto.
    if (["/v1/rest/query", "/v1/rest/mgmt", "/v2/rest/query"].includes(url.pathname)) {
      const handler = handlers.get(`${url.pathname} ${entry.body.csl}`) ?? handlers.get(entry.body.csl);
      if (!handler) {
        return send(400, { error: { code: "General_BadRequest", message: "Request is invalid and cannot be executed.", "@type": "Kusto.Data.Exceptions.SyntaxException", "@message": `Syntax error: unknown command ${entry.body.csl}`, "@permanent": true } });
      }
      const result = typeof handler === "function" ? handler(entry) : handler;
      if (result && result.__delay) {
        await new Promise((resolve) => setTimeout(resolve, result.__delay));
        if (response.destroyed) return undefined;
        return send(200, result.body);
      }
      if (result && result.__status) return send(result.__status, result.body);
      return send(200, result);
    }
    const ingest = /^\/v1\/rest\/ingest\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (ingest) {
      if (decodeURIComponent(ingest[2]) === "Missing") return send(404, { error: { code: "NotFound", "@message": "Table 'Missing' not found" } });
      response.writeHead(200);
      return response.end();
    }
    return send(404, { error: { code: "NotFound", message: `no route ${request.method} ${url.pathname}` } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  // Resolve cluster names to this fake, so --cluster calls stay local.
  for (const cluster of clusters) cluster.properties.uri = url;
  return {
    url,
    requests,
    handlers,
    clusters,
    fail: (path, status, times = 1, extra = {}) => failures.push({ path, status, times, ...extra }),
    get tokenCount() {
      return tokenCount;
    },
    reset() {
      requests.length = 0;
      handlers.clear();
      failures.length = 0;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Environment that points a spawned server at the fake. */
export function fakeEnv(fake, extra = {}) {
  return {
    AZURE_TENANT_ID: TENANT,
    AZURE_CLIENT_ID: CLIENT_ID,
    AZURE_CLIENT_SECRET: CLIENT_SECRET,
    AZURE_AUTHORITY_HOST: fake.url,
    AZURE_RESOURCE_MANAGER_URL: fake.url,
    AZURE_SUBSCRIPTION_ID: SUBSCRIPTION,
    KUSTO_ALLOW_HTTP: "1",
    KUSTO_EXTRA_HOSTS: "127.0.0.1",
    KUSTO_RETRIES: "2",
    ...extra,
  };
}

// Kusto (Azure Data Explorer) data-plane REST client.
// https://learn.microsoft.com/en-us/kusto/api/rest/
import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";

import { fetchWithRetry, HttpError, Limiter } from "./http.mjs";
import { ArgumentError } from "./kql.mjs";

// Kusto host suffixes and exact hosts accepted by azure-mcp 3.0.0-beta.49
// (KustoClient.cs). They block requests to arbitrary hosts.
export const KUSTO_HOST_SUFFIXES = [
  ".dxp.aad.azure.com",
  ".dxp-dev.aad.azure.com",
  ".kusto.azuresynapse.net",
  ".kusto.windows.net",
  ".kustodev.azuresynapse-dogfood.net",
  ".kustodev.windows.net",
  ".kustomfa.windows.net",
  ".kusto.data.microsoft.com",
  ".kusto.fabric.microsoft.com",
  ".adx.loganalytics.azure.com",
  ".adx.applicationinsights.azure.com",
  ".adx.monitor.azure.com",
  ".kusto.usgovcloudapi.net",
  ".kustomfa.usgovcloudapi.net",
  ".adx.loganalytics.azure.us",
  ".adx.applicationinsights.azure.us",
  ".adx.monitor.azure.us",
  ".kusto.azuresynapse.azure.cn",
  ".kusto.chinacloudapi.cn",
  ".kustomfa.chinacloudapi.cn",
  ".adx.loganalytics.azure.cn",
  ".adx.applicationinsights.azure.cn",
  ".adx.monitor.azure.cn",
  ".kusto.sovcloud-api.de",
  ".kustomfa.sovcloud-api.de",
];

export const KUSTO_HOSTS = new Set([
  "kusto.aria.microsoft.com",
  "eu.kusto.aria.microsoft.com",
  "ade.applicationinsights.io",
  "ade.loganalytics.io",
  "adx.aimon.applicationinsights.azure.com",
  "adx.applicationinsights.azure.com",
  "adx.loganalytics.azure.com",
  "adx.monitor.azure.com",
  "adx.applicationinsights.azure.us",
  "adx.loganalytics.azure.us",
  "adx.monitor.azure.us",
  "adx.applicationinsights.azure.cn",
  "adx.loganalytics.azure.cn",
  "adx.monitor.azure.cn",
  "adx.applicationinsights.azure.de",
  "adx.loganalytics.azure.de",
  "adx.monitor.azure.de",
]);

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export function isKustoHost(host, extraSuffixes = [], extraHosts = []) {
  const lower = host.toLowerCase();
  if (KUSTO_HOSTS.has(lower) || extraHosts.includes(lower)) return true;
  const suffix = [...KUSTO_HOST_SUFFIXES, ...extraSuffixes].find((candidate) => lower.endsWith(candidate.toLowerCase()));
  if (!suffix) return false;
  const cluster = lower.slice(0, -suffix.length);
  return cluster.length > 0 && cluster.split(".").every((segment) => SEGMENT.test(segment));
}

/**
 * Validate and normalize a cluster URI (azure-mcp ValidateAndNormalizeClusterUri).
 * Errors are ArgumentExceptions on parameter clusterUri, as in azure-mcp.
 * allowedClusters, when non-empty, is an exact allowlist of normalized URIs.
 */
export function normalizeClusterUri(clusterUri, { extraSuffixes = [], extraHosts = [], allowHttp = false, allowedClusters = [] } = {}) {
  if (typeof clusterUri !== "string" || !clusterUri.trim()) {
    throw new ArgumentError("The value cannot be an empty string or composed entirely of whitespace.", "clusterUri");
  }
  const normalized = clusterUri.trim().replace(/\/+$/, "");
  let uri;
  try {
    uri = new URL(normalized);
  } catch {
    throw new ArgumentError(`Invalid Kusto cluster URI format: '${clusterUri}'`, "clusterUri");
  }
  if (uri.protocol !== "https:" && !(allowHttp && uri.protocol === "http:")) {
    throw new ArgumentError("Kusto cluster URI must use HTTPS scheme.", "clusterUri");
  }
  if (uri.username || uri.password || uri.search || uri.hash) {
    throw new ArgumentError("Kusto cluster URI must not contain credentials, a query, or a fragment.", "clusterUri");
  }
  if (!isKustoHost(uri.hostname, extraSuffixes, extraHosts)) {
    throw new ArgumentError(`Invalid Kusto cluster URI. Must be a valid Azure Data Explorer cluster endpoint (e.g., https://clustername.region.kusto.windows.net). Received host: '${uri.hostname}'`, "clusterUri");
  }
  const result = `${uri.origin}${uri.pathname.replace(/\/+$/, "")}`;
  if (allowedClusters.length && !allowedClusters.includes(result.toLowerCase())) {
    throw new ArgumentError(`Kusto cluster '${result}' is not in this server's KUSTO_ALLOWED_CLUSTERS list.`, "clusterUri");
  }
  return result;
}

/** Token scope for a cluster host (azure-mcp GetKustoScope). */
export function kustoScope(clusterUri) {
  const host = new URL(clusterUri).hostname.toLowerCase();
  if (host.endsWith(".chinacloudapi.cn") || host.endsWith(".azure.cn")) return "https://kusto.kusto.chinacloudapi.cn/.default";
  if (host.endsWith(".usgovcloudapi.net") || host.endsWith(".azure.us")) return "https://kusto.kusto.usgovcloudapi.net/.default";
  return "https://kusto.kusto.windows.net/.default";
}

const statusName = (status) => (STATUS_CODES[status] ?? String(status)).replace(/[^A-Za-z0-9]/g, "");

export const STREAM_FORMATS = ["csv", "tsv", "scsv", "sohsv", "psv", "json", "multijson"];
const ERROR_BODY_BYTES = 64 * 1024;

/**
 * Parse JSON and keep each number's exact source text when a JS number would
 * change it (longs above 2^53, 1.0E-7, 1.50). JSON.stringify writes the raw
 * text back, as azure-mcp's JsonElement does.
 */
export function parseExact(text) {
  return JSON.parse(text, (key, value, context) => {
    if (typeof value === "number" && context?.source !== undefined && String(value) !== context.source) return JSON.rawJSON(context.source);
    return value;
  });
}

export class KustoClient {
  constructor({ tokens, fetch: fetchImpl = globalThis.fetch, timeoutMs = 240_000, retries = 3, maxConcurrency = 8, app = "kusto-mcp", version = "0", extraSuffixes = [], extraHosts = [], allowedClusters = [], allowHttp = false, scopeOverride, maxResponseBytes = 64 * 1024 * 1024, log = () => {} }) {
    this.tokens = tokens;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.limiter = new Limiter(maxConcurrency);
    this.app = app;
    this.version = version;
    this.extraSuffixes = extraSuffixes;
    this.extraHosts = extraHosts;
    this.allowedClusters = allowedClusters.map((uri) => uri.replace(/\/+$/, "").toLowerCase());
    this.allowHttp = allowHttp;
    this.scopeOverride = scopeOverride;
    this.maxResponseBytes = maxResponseBytes;
    this.log = log;
  }

  normalize(clusterUri) {
    return normalizeClusterUri(clusterUri, { extraSuffixes: this.extraSuffixes, extraHosts: this.extraHosts, allowHttp: this.allowHttp, allowedClusters: this.allowedClusters });
  }

  async #headers(clusterUri, tenant, clientRequestId) {
    const token = await this.tokens.token(this.scopeOverride ?? kustoScope(clusterUri), tenant);
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": `kusto-mcp/${this.version}`,
      "x-ms-client-request-id": clientRequestId,
      "x-ms-app": this.app,
      "x-ms-client-version": `kusto-mcp/${this.version}`,
    };
  }

  async #send(url, init, { retry, describe, signal }) {
    return this.limiter.run(async () => {
      if (signal?.aborted) throw new HttpError("Kusto request was cancelled", { status: 499, name: "TaskCanceledException" });
      const started = Date.now();
      const response = await fetchWithRetry(this.fetch, url, init, { timeoutMs: this.timeoutMs, retries: retry ? this.retries : 0, signal });
      if (!response.ok) {
        const text = (await readCapped(response, ERROR_BODY_BYTES, { truncate: true, timeoutMs: this.timeoutMs, signal })).toString("utf8");
        this.log(`${describe} ${response.status} ${Date.now() - started}ms`);
        // azure-mcp throws HttpRequestException without a status here. The
        // compatible commands map it back to 503; see commands.mjs.
        throw new HttpError(`Request failed with status code ${statusName(response.status)}: ${text.slice(0, 4000)}`, {
          status: response.status,
          requestId: init.headers["x-ms-client-request-id"],
          code: safeErrorCode(text),
          source: "kusto",
        });
      }
      const buffer = await readCapped(response, this.maxResponseBytes, { timeoutMs: this.timeoutMs, signal });
      this.log(`${describe} ${response.status} ${Date.now() - started}ms`);
      return buffer.toString("utf8");
    });
  }

  /**
   * POST a v1 query or management request.
   * @param {"query"|"mgmt"} kind
   */
  async v1(kind, clusterUri, { database, csl, options, parameters, tenant, retry = true, signal, clientRequestId = newRequestId(kind) }) {
    const base = this.normalize(clusterUri);
    const properties = { ClientRequestId: clientRequestId };
    if (options && Object.keys(options).length) properties.Options = options;
    if (parameters && Object.keys(parameters).length) properties.Parameters = parameters;
    const body = { db: database, csl, properties };
    const headers = { ...(await this.#headers(base, tenant, clientRequestId)), "Content-Type": "application/json; charset=utf-8" };
    const text = await this.#send(`${base}/v1/rest/${kind}`, { method: "POST", headers, body: JSON.stringify(body) }, { retry, describe: `v1/${kind}`, signal });
    return parseJson(text);
  }

  /** POST a v2 query and return the parsed frame array. */
  async v2Query(clusterUri, { database, csl, options, parameters, tenant, signal, clientRequestId = newRequestId("query2") }) {
    const base = this.normalize(clusterUri);
    const properties = { ClientRequestId: clientRequestId, Options: { results_progressive_enabled: false, ...options } };
    if (parameters && Object.keys(parameters).length) properties.Parameters = parameters;
    const headers = { ...(await this.#headers(base, tenant, clientRequestId)), "Content-Type": "application/json; charset=utf-8" };
    const text = await this.#send(`${base}/v2/rest/query`, { method: "POST", headers, body: JSON.stringify({ db: database, csl, properties }) }, { retry: true, describe: "v2/query", signal });
    const frames = parseJson(text);
    if (!Array.isArray(frames)) throw new HttpError("v2 query returned an unexpected response shape", { status: 502 });
    return { frames, clientRequestId };
  }

  /** Streaming ingestion. Never retried: a lost response may hide a completed ingest. */
  async ingest(clusterUri, { database, table, format, mappingName, data, tenant, signal, clientRequestId = newRequestId("ingest") }) {
    const base = this.normalize(clusterUri);
    const query = new URLSearchParams({ streamFormat: format });
    if (mappingName) query.set("mappingName", mappingName);
    const url = `${base}/v1/rest/ingest/${encodeURIComponent(database)}/${encodeURIComponent(table)}?${query}`;
    // The REST reference lists no Content-Type for ingestion; the body is the
    // UTF-8 data in the named stream format.
    const headers = await this.#headers(base, tenant, clientRequestId);
    const text = await this.#send(url, { method: "POST", headers, body: Buffer.from(data, "utf8") }, { retry: false, describe: "v1/ingest", signal });
    return { response: text ? parseJson(text) : null, clientRequestId };
  }
}

export const newRequestId = (kind) => `KustoMcp.${kind};${randomUUID()}`;

function parseJson(text) {
  if (!text) return null;
  try {
    return parseExact(text);
  } catch {
    throw new HttpError("Kusto returned invalid JSON", { status: 502 });
  }
}

function safeErrorCode(text) {
  try {
    return JSON.parse(text)?.error?.code;
  } catch {
    return undefined;
  }
}

async function readCapped(response, max, { truncate = false, timeoutMs, signal } = {}) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > max) {
        await response.body.cancel?.().catch(() => {});
        if (truncate) {
          chunks.push(Buffer.from(chunk).subarray(0, Math.max(0, chunk.length - (size - max))));
          break;
        }
        throw new HttpError(`Kusto response exceeds ${max} bytes. Narrow the query (for example with take, project, or summarize).`, { status: 413 });
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (signal?.aborted) throw new HttpError("Kusto request was cancelled", { status: 499, name: "TaskCanceledException" });
    if (error?.name === "TimeoutError") throw new HttpError(`Reading the Kusto response timed out after ${timeoutMs} ms`, { status: 504 });
    if (error?.name === "AbortError") throw new HttpError("Kusto request was cancelled", { status: 499, name: "TaskCanceledException" });
    throw new HttpError(`Reading the Kusto response failed: ${error?.message ?? error}`, { status: 502 });
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

/** The first table of a v1 response, or undefined. */
export function firstTable(result) {
  const tables = result?.Tables;
  return Array.isArray(tables) && tables.length ? tables[0] : undefined;
}

/** azure-mcp KustoResultToStringList: "Col:type,..." then each row as JSON text. */
export function toStringList(result) {
  const table = firstTable(result);
  if (!table || !Array.isArray(table.Columns)) return [];
  const list = [table.Columns.map((column) => `${column.ColumnName}:${column.ColumnType}`).join(",")];
  if (Array.isArray(table.Rows)) for (const row of table.Rows) list.push(JSON.stringify(row));
  return list;
}

/** azure-mcp QueryItemsAsync: {column: type} then each row array. */
export function toItems(result) {
  const table = firstTable(result);
  if (!table || !Array.isArray(table.Columns)) return [];
  const columns = {};
  for (const column of table.Columns) columns[column.ColumnName] = column.ColumnType;
  const items = [columns];
  if (Array.isArray(table.Rows)) for (const row of table.Rows) items.push(row);
  return items;
}

/** Rows of the first table as objects keyed by column name. */
export function toObjects(result) {
  const table = firstTable(result);
  if (!table || !Array.isArray(table.Columns) || !Array.isArray(table.Rows)) return [];
  const names = table.Columns.map((column) => column.ColumnName);
  return table.Rows.map((row) => Object.fromEntries(names.map((name, index) => [name, row[index]])));
}

/**
 * Collapse v2 frames into tables plus completion. Accepts both DataTable frames
 * and progressive TableHeader/TableFragment/TableCompletion sequences. A
 * response without DataSetCompletion is reported as incomplete.
 */
export function parseV2(frames) {
  const tables = new Map();
  let completion;
  for (const frame of frames) {
    const type = frame?.FrameType ?? inferFrameType(frame);
    if (type === "DataTable") {
      tables.set(frame.TableId, { id: frame.TableId, kind: frame.TableKind, name: frame.TableName, columns: frame.Columns ?? [], rows: frame.Rows ?? [] });
    } else if (type === "TableHeader") {
      tables.set(frame.TableId, { id: frame.TableId, kind: frame.TableKind, name: frame.TableName, columns: frame.Columns ?? [], rows: [] });
    } else if (type === "TableFragment") {
      const table = tables.get(frame.TableId);
      if (table) {
        if (frame.TableFragmentType === "DataReplace") table.rows = [];
        for (const row of frame.Rows ?? []) table.rows.push(row);
      }
    } else if (type === "DataSetCompletion") {
      completion = { hasErrors: Boolean(frame.HasErrors), cancelled: Boolean(frame.Cancelled), errors: frame.OneApiErrors ?? [], complete: true };
    }
  }
  return {
    tables: [...tables.values()],
    completion: completion ?? { hasErrors: true, cancelled: false, errors: [{ error: { code: "IncompleteResponse", message: "The v2 response ended without a DataSetCompletion frame." } }], complete: false },
  };
}

function inferFrameType(frame) {
  if (!frame || typeof frame !== "object") return undefined;
  if ("HasErrors" in frame) return "DataSetCompletion";
  if ("Version" in frame && "IsProgressive" in frame) return "DataSetHeader";
  if ("TableFragmentType" in frame) return "TableFragment";
  if ("RowCount" in frame) return "TableCompletion";
  if ("Rows" in frame && "TableKind" in frame) return "DataTable";
  if ("Columns" in frame && "TableKind" in frame) return "TableHeader";
  return undefined;
}

// Tool and command definitions. The seven azure-mcp commands keep their exact
// names, descriptions, input schemas, and result shapes (azure-mcp
// 3.0.0-beta.49). Everything else is additive.
import { escapeKqlIdentifier, sanitizeStringLiterals, validateIdentifier, validateQuerySafety, validateShowCommand, validateV2Query, ValidationError } from "./kql.mjs";
import { parseV2, STREAM_FORMATS, toItems, toObjects, toStringList } from "./kusto.mjs";
import { resolveSubscriptionOption } from "./arm.mjs";

export const TROUBLESHOOTING_URL = "https://aka.ms/azmcp/troubleshooting";
const MISSING_PREFIX = "Missing Required options: ";

// Shared parameter schemas, worded exactly as azure-mcp words them.
const P = {
  limit: { type: ["integer", "null"], description: "The maximum number of results to return. Must be a positive integer between 1 and 10000. Default is 10." },
  table: { type: "string", description: "Kusto Table name." },
  database: { type: "string", description: "Kusto Database name." },
  "cluster-uri": { type: "string", description: "Kusto Cluster URI." },
  cluster: { type: "string", description: "Kusto Cluster name." },
  subscription: { type: "string", description: "The Azure subscription GUID identifier or display name. If not specified, the Azure CLI profile default subscription or AZURE_SUBSCRIPTION_ID environment variable will be used." },
  tenant: { type: "string", description: "The Microsoft Entra ID tenant GUID identifier or display name." },
  query: { type: "string", description: "Kusto query to execute. Uses KQL syntax." },
  "resource-group": { type: "string", description: "The Azure resource group name." },
};

const pick = (...names) => Object.fromEntries(names.map((name) => [name, P[name]]));
const CLUSTER = ["cluster-uri", "cluster", "subscription", "tenant"];
const schema = (properties, required) => ({
  type: "object",
  properties,
  ...(required ? { required } : {}),
  additionalProperties: false,
});

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const maxRowsSchema = (fallback) => ({ type: "integer", minimum: 1, maximum: 100000, description: `Most rows to return per table. Default ${fallback}. Extra rows are dropped and the table is marked truncated.` });
const databaseOptional = { type: "string", description: "Kusto Database name. Optional for cluster-level commands; defaults to NetDefaultDB." };

// Client request properties a caller may set on kusto_query_v2. Safety
// properties (request_readonly and the request_*_disabled family) are fixed by
// the server and cannot be overridden.
export const V2_OPTIONS = {
  servertimeout: "string",
  truncationmaxrecords: "integer",
  truncationmaxsize: "integer",
  notruncation: "boolean",
  query_datetimescope_column: "string",
  query_datetimescope_from: "string",
  query_datetimescope_to: "string",
  query_now: "string",
  query_language: "string",
  query_results_cache_max_age: "string",
  maxmemoryconsumptionperiterator: "integer",
  max_memory_consumption_per_query_per_node: "integer",
  query_fanout_threads_percent: "integer",
  query_fanout_nodes_percent: "integer",
  deferpartialqueryfailures: "boolean",
  query_force_row_level_security: "boolean",
};

/**
 * Command table. `compat` marks the azure-mcp commands; their `description`
 * and `inputSchema` must not change. `router` puts the command behind the
 * `kusto` namespace tool. `write` commands are only registered when writes are
 * enabled, and never go behind the router, so a gateway can gate them by name.
 */
export const COMMANDS = [
  {
    name: "kusto_sample",
    title: "Sample Kusto Table Data",
    compat: true,
    router: true,
    annotations: READ,
    description: "Return a sample of rows from a specific table in an Azure Data Explorer/Kusto/KQL cluster. Required: --cluster-uri (or --cluster and --subscription), --database, and --table.",
    inputSchema: schema(pick("limit", "table", "database", ...CLUSTER), ["table", "database"]),
    clusterScoped: true,
    async run(ctx, a) {
      const limit = Math.min(Math.max(a.limit ?? 10, 1), 10000);
      const query = `${escapeKqlIdentifier(a.table)} | sample ${limit}`;
      return { results: await ctx.queryItems(a, query) };
    },
  },
  {
    name: "kusto_query",
    title: "Query Kusto Database",
    compat: true,
    router: true,
    annotations: READ,
    description: "Executes a query against an Azure Data Explorer/Kusto/KQL cluster to search for specific terms, retrieve records, or perform management operations. Required: --cluster-uri (or --cluster and --subscription), --database, and --query.",
    inputSchema: schema(pick("query", "database", ...CLUSTER), ["query", "database"]),
    clusterScoped: true,
    async run(ctx, a) {
      return { items: await ctx.queryItems(a, a.query) };
    },
  },
  {
    name: "kusto_cluster_list",
    title: "List Kusto Clusters",
    compat: true,
    router: true,
    annotations: READ,
    description: "List/enumerate all Azure Data Explorer/Kusto/KQL clusters in a subscription.",
    inputSchema: schema(pick("resource-group", "subscription", "tenant")),
    async run(ctx, a) {
      return ctx.arm.listClusters({ subscription: a.subscription, resourceGroup: a["resource-group"], tenant: a.tenant, signal: ctx.signal });
    },
  },
  {
    name: "kusto_cluster_get",
    title: "Get Kusto Cluster Details",
    compat: true,
    router: true,
    annotations: READ,
    description: "Get/retrieve/show details for a specific Azure Data Explorer/Kusto/KQL cluster in a subscription. Not for listing multiple clusters. Required: --cluster and --subscription.",
    inputSchema: schema(pick("cluster", "subscription", "tenant"), ["cluster"]),
    // azure-mcp ClusterGetCommand.GetErrorMessage.
    errorMessage(error) {
      if (error?.name === "KeyNotFoundException" && error.kind === "cluster") return "Kusto cluster not found. Verify the cluster name, resource group, and that you have access.";
      if (error?.name === "RequestFailedException" && error.status === 404) return "Kusto cluster not found. Verify the cluster name, resource group, and subscription, and ensure you have access.";
      if (error?.name === "RequestFailedException" && error.status === 403) return `Authorization failed accessing the Kusto cluster. Details: ${error.message}`;
      return undefined;
    },
    async run(ctx, a) {
      return { cluster: await ctx.arm.getCluster({ subscription: a.subscription, cluster: a.cluster, tenant: a.tenant, signal: ctx.signal }) };
    },
  },
  {
    name: "kusto_database_list",
    title: "List Kusto Databases",
    compat: true,
    router: true,
    annotations: READ,
    description: "List/enumerate all databases in an Azure Data Explorer/Kusto/KQL cluster. Required: --cluster-uri ( or --cluster and --subscription).",
    inputSchema: schema(pick(...CLUSTER)),
    clusterScoped: true,
    async run(ctx, a) {
      const result = await ctx.mgmt(a, "NetDefaultDB", ".show databases | project DatabaseName");
      return { databases: toStringList(result) };
    },
  },
  {
    name: "kusto_table_list",
    title: "List Kusto Tables",
    compat: true,
    router: true,
    annotations: READ,
    description: "List/enumerate all tables in a specific Azure Data Explorer/Kusto/KQL database. Required: --cluster-uri (or --cluster and --subscription), --database.",
    inputSchema: schema(pick("database", ...CLUSTER), ["database"]),
    clusterScoped: true,
    async run(ctx, a) {
      const result = await ctx.mgmt(a, a.database, ".show tables");
      return { tables: toStringList(result) };
    },
  },
  {
    name: "kusto_table_schema",
    title: "Get Kusto Table Schema",
    compat: true,
    router: true,
    annotations: READ,
    description: "Get/retrieve/show the schema of a specific table in an Azure Data Explorer/Kusto/KQL cluster. Required: --cluster-uri (or --cluster and --subscription), --database, and --table.",
    inputSchema: schema(pick("table", "database", ...CLUSTER), ["table", "database"]),
    clusterScoped: true,
    async run(ctx, a) {
      validateIdentifier(a.table, "tableName");
      const result = await ctx.query(a, a.database, `.show table ${escapeKqlIdentifier(a.table)} cslschema`);
      const list = toStringList(result);
      if (!list.length) throw new Error(`No schema found for table '${a.table}' in database '${a.database}'.`);
      return { schema: list.join("\n") };
    },
  },

  // Additive read tools.
  {
    name: "kusto_query_v2",
    title: "Query Kusto Database (v2)",
    router: true,
    annotations: READ,
    description: "Run a read-only KQL query through the Kusto v2 query API. Supports query parameters (declare them in the query with `declare query_parameters(...)`), selected client request properties such as servertimeout and the datetime scope, and returns every result table with typed columns and a row cap. Management commands are refused and the request always runs read-only. Required: --cluster-uri (or --cluster and --subscription), --database, and --query.",
    inputSchema: schema({
      query: P.query,
      database: P.database,
      "query-parameters": { type: "object", additionalProperties: { type: ["string", "integer", "boolean"] }, description: "Values for parameters the query declares with `declare query_parameters(name:type, ...)`. Strings and integers pass as is; give other types as KQL literals in string form, such as \"datetime(2026-01-01)\" or \"dynamic([1,2])\"." },
      options: { type: "object", additionalProperties: false, properties: Object.fromEntries(Object.entries(V2_OPTIONS).map(([key, type]) => [key, { type }])), description: "Client request properties. Allowed: servertimeout (timespan such as \"00:02:00\"), truncationmaxrecords, truncationmaxsize, notruncation, query_datetimescope_column, query_datetimescope_from, query_datetimescope_to, query_now, query_language (kql, csl, or sql), query_results_cache_max_age, maxmemoryconsumptionperiterator, max_memory_consumption_per_query_per_node, query_fanout_threads_percent, query_fanout_nodes_percent, deferpartialqueryfailures, query_force_row_level_security." },
      "max-rows": maxRowsSchema(1000),
      "include-secondary": { type: "boolean", description: "Also return the non-primary tables, such as QueryCompletionInformation and QueryProperties. Default false." },
      ...pick(...CLUSTER),
    }, ["query", "database"]),
    clusterScoped: true,
    async run(ctx, a) {
      validateV2Query(a.query, ctx.config.maxV2QueryLength);
      // Always read-only, whatever KUSTO_QUERY_READONLY says.
      const options = { ...validateOptions(a.options), ...ctx.readOnlyOptions(true) };
      const parameters = validateParameters(a["query-parameters"]);
      const uri = await ctx.clusterUri(a);
      const { frames, clientRequestId } = await ctx.kusto.v2Query(uri, { database: a.database, csl: a.query, options, parameters, tenant: a.tenant, signal: ctx.signal });
      const { tables, completion } = parseV2(frames);
      const maxRows = a["max-rows"] ?? 1000;
      const shown = tables.filter((table) => a["include-secondary"] || table.kind === "PrimaryResult");
      const output = {
        tables: shown.map((table) => shapeTable(table, maxRows)),
        hasErrors: completion.hasErrors,
        cancelled: completion.cancelled,
        ...(completion.errors.length ? { errors: completion.errors } : {}),
        clientRequestId,
      };
      if (completion.hasErrors || completion.cancelled) {
        const partial = completion.complete && shown.some((table) => table.rows.length);
        const message = completion.cancelled ? "Query was cancelled." : completion.complete ? "Query completed with errors; see results.errors." : "The response was incomplete; see results.errors.";
        return { results: output, status: partial ? 206 : 500, message };
      }
      return output;
    },
  },
  {
    name: "kusto_command",
    title: "Run Kusto .show Command",
    router: true,
    annotations: READ,
    description: "Run one read-only `.show` management command (for example `.show queries`, `.show commands`, `.show ingestion failures`, `.show table T policy retention`, `.show diagnostics`) through the management API. The command may pipe into query operators. Any other control command is refused. Required: --cluster-uri (or --cluster and --subscription), and --command.",
    inputSchema: schema({
      command: { type: "string", description: "The .show management command to run." },
      database: databaseOptional,
      "max-rows": maxRowsSchema(1000),
      ...pick(...CLUSTER),
    }, ["command"]),
    clusterScoped: true,
    async run(ctx, a) {
      const command = validateShowCommand(a.command, ctx.config.maxV2QueryLength);
      const result = await ctx.mgmt(a, a.database || "NetDefaultDB", command, { forceReadOnly: true });
      return { tables: v1Tables(result, a["max-rows"] ?? 1000) };
    },
  },
  {
    name: "kusto_database_schema",
    title: "Get Kusto Database Schema",
    router: true,
    annotations: READ,
    description: "Get the schema of a whole Kusto database as JSON: tables with ordered columns and types, plus functions, materialized views, and external tables. Pass --table to return one table only. Required: --cluster-uri (or --cluster and --subscription), and --database.",
    inputSchema: schema({ database: P.database, table: { type: "string", description: "Optional table name. Returns only this table's schema." }, ...pick(...CLUSTER) }, ["database"]),
    clusterScoped: true,
    async run(ctx, a) {
      validateIdentifier(a.database, "database");
      if (a.table !== undefined) validateIdentifier(a.table, "table");
      const result = await ctx.mgmt(a, a.database, `.show database ${escapeKqlIdentifier(a.database)} schema as json`);
      const cell = firstCell(result);
      let parsed;
      try {
        parsed = typeof cell === "string" ? JSON.parse(cell) : cell;
      } catch {
        throw new Error("Kusto returned a database schema that is not valid JSON.");
      }
      const databases = parsed?.Databases ?? {};
      const key = Object.keys(databases).find((name) => name.toLowerCase() === a.database.toLowerCase()) ?? Object.keys(databases)[0];
      const db = key ? databases[key] : undefined;
      if (!db) throw new Error(`No schema found for database '${a.database}'.`);
      if (a.table !== undefined) {
        const tables = db.Tables ?? {};
        const name = Object.keys(tables).find((candidate) => candidate.toLowerCase() === a.table.toLowerCase());
        if (!name) throw new ValidationError(`Table '${a.table}' not found in database '${a.database}'.`, 404);
        return { schema: tables[name] };
      }
      return { schema: db };
    },
  },
  {
    name: "kusto_function_list",
    title: "List Kusto Functions",
    router: true,
    annotations: READ,
    description: "List the stored functions in a Kusto database with their parameters, folder, and doc string. Bodies are left out; use kusto_function_get for one function's body. Required: --cluster-uri (or --cluster and --subscription), and --database.",
    inputSchema: schema(pick("database", ...CLUSTER), ["database"]),
    clusterScoped: true,
    async run(ctx, a) {
      const rows = toObjects(await ctx.mgmt(a, a.database, ".show functions"));
      return { functions: rows.map((row) => ({ name: row.Name, parameters: row.Parameters, folder: row.Folder, docString: row.DocString })) };
    },
  },
  {
    name: "kusto_function_get",
    title: "Get Kusto Function",
    router: true,
    annotations: READ,
    description: "Get one stored function from a Kusto database: parameters, body, folder, and doc string. Required: --cluster-uri (or --cluster and --subscription), --database, and --function.",
    inputSchema: schema({ function: { type: "string", description: "Kusto function name." }, database: P.database, ...pick(...CLUSTER) }, ["function", "database"]),
    clusterScoped: true,
    async run(ctx, a) {
      validateIdentifier(a.function, "function");
      const rows = toObjects(await ctx.mgmt(a, a.database, `.show function ${escapeKqlIdentifier(a.function)}`));
      if (!rows.length) throw new ValidationError(`Function '${a.function}' not found in database '${a.database}'.`, 404);
      const row = rows[0];
      return { function: { name: row.Name, parameters: row.Parameters, body: row.Body, folder: row.Folder, docString: row.DocString } };
    },
  },
  {
    name: "kusto_principal_details",
    title: "Get Kusto Caller Identity",
    router: true,
    annotations: READ,
    description: "Show the identity this server authenticates to Kusto as (current_principal_details()), for diagnosing access errors. Required: --cluster-uri (or --cluster and --subscription), and --database.",
    inputSchema: schema(pick("database", ...CLUSTER), ["database"]),
    clusterScoped: true,
    async run(ctx, a) {
      const result = await ctx.query(a, a.database, "print details=current_principal_details()");
      const cell = firstCell(result);
      return { principal: typeof cell === "string" ? safeParse(cell) : cell };
    },
  },

  // Write tools. Registered only with KUSTO_ENABLE_WRITES=1; never routed.
  {
    name: "kusto_command_write",
    title: "Run Kusto Control Command",
    write: true,
    annotations: DESTRUCTIVE,
    description: "Run any Kusto control command through the management API, including commands that change data, schema, or policy (for example `.create table`, `.alter table policy`, `.set-or-append`, `.drop table`). Not retried. Set confirm to true. Required: --cluster-uri (or --cluster and --subscription), --command, and --confirm.",
    inputSchema: schema({
      command: { type: "string", description: "The control command to run." },
      database: databaseOptional,
      confirm: { type: "boolean", description: "Must be true. Confirms that the command may change the cluster." },
      "max-rows": maxRowsSchema(1000),
      ...pick(...CLUSTER),
    }, ["command", "confirm"]),
    clusterScoped: true,
    async run(ctx, a) {
      if (a.confirm !== true) throw new ValidationError("confirm must be true to run a control command.");
      const command = a.command.trim();
      if (!command.startsWith(".")) throw new ValidationError("A control command starts with '.'. Use kusto_query for queries.");
      if (command.length > ctx.config.maxV2QueryLength) throw new ValidationError(`Command length exceeds the maximum allowed limit of ${ctx.config.maxV2QueryLength.toLocaleString("en-US")} characters.`);
      const uri = await ctx.clusterUri(a);
      const result = await ctx.kusto.v1("mgmt", uri, { database: a.database || "NetDefaultDB", csl: command, tenant: a.tenant, retry: false, signal: ctx.signal });
      return { tables: v1Tables(result, a["max-rows"] ?? 1000) };
    },
  },
  {
    name: "kusto_query_cancel",
    title: "Cancel Kusto Query",
    write: true,
    annotations: WRITE,
    description: "Cancel a running query by its client request ID (`.cancel query`). Find IDs with kusto_command `.show running queries`. Required: --cluster-uri (or --cluster and --subscription), and --client-request-id.",
    inputSchema: schema({
      "client-request-id": { type: "string", description: "ClientActivityId of the running query." },
      reason: { type: "string", description: "Optional cancellation reason recorded with the query." },
      ...pick(...CLUSTER),
    }, ["client-request-id"]),
    clusterScoped: true,
    async run(ctx, a) {
      const id = a["client-request-id"];
      if (!/^[A-Za-z0-9._;:-]{1,256}$/.test(id)) throw new ValidationError("client-request-id may contain only letters, digits, and . _ ; : -");
      let command = `.cancel query "${id}"`;
      if (a.reason !== undefined) command += ` with (reason=${JSON.stringify(String(a.reason).slice(0, 500))})`;
      const uri = await ctx.clusterUri(a);
      const result = await ctx.kusto.v1("mgmt", uri, { database: "NetDefaultDB", csl: command, tenant: a.tenant, retry: false, signal: ctx.signal });
      return { tables: v1Tables(result, 100) };
    },
  },
  {
    name: "kusto_ingest_stream",
    title: "Stream Ingest Into Kusto Table",
    write: true,
    annotations: WRITE,
    description: "Ingest a small batch of text data into a table with streaming ingestion (POST /v1/rest/ingest). Streaming ingestion must be enabled on the cluster and on the table or database. JSON and MultiJSON need an existing ingestion mapping. Not retried. Required: --cluster-uri (or --cluster and --subscription), --database, --table, --format, --data, and --confirm.",
    inputSchema: schema({
      database: P.database,
      table: P.table,
      format: { type: "string", enum: STREAM_FORMATS, description: "Stream format of data." },
      "mapping-name": { type: "string", description: "Name of a pre-created ingestion mapping on the table. Required for json and multijson." },
      data: { type: "string", description: "The data to ingest, as UTF-8 text in the given format." },
      confirm: { type: "boolean", description: "Must be true. Confirms that the data may be written." },
      ...pick(...CLUSTER),
    }, ["database", "table", "format", "data", "confirm"]),
    clusterScoped: true,
    async run(ctx, a) {
      if (a.confirm !== true) throw new ValidationError("confirm must be true to ingest data.");
      validateIdentifier(a.database, "database");
      validateIdentifier(a.table, "table");
      const format = a.format.toLowerCase();
      if (!STREAM_FORMATS.includes(format)) throw new ValidationError(`format must be one of: ${STREAM_FORMATS.join(", ")}`);
      if ((format === "json" || format === "multijson") && !a["mapping-name"]) throw new ValidationError(`${MISSING_PREFIX}--mapping-name`);
      if (a["mapping-name"] !== undefined) validateIdentifier(a["mapping-name"], "mapping-name");
      const bytes = Buffer.byteLength(a.data, "utf8");
      if (!bytes) throw new ValidationError("data cannot be empty.");
      if (bytes > ctx.config.maxIngestBytes) throw new ValidationError(`data is ${bytes} bytes; the limit is ${ctx.config.maxIngestBytes}.`, 413);
      const uri = await ctx.clusterUri(a);
      const { response, clientRequestId } = await ctx.kusto.ingest(uri, { database: a.database, table: a.table, format, mappingName: a["mapping-name"], data: a.data, tenant: a.tenant, signal: ctx.signal });
      return { ingested: true, bytes, clientRequestId, ...(response ? { response } : {}) };
    },
  },
];

function validateOptions(options) {
  if (options === undefined) return {};
  const out = {};
  for (const [key, value] of Object.entries(options)) {
    const type = V2_OPTIONS[key];
    if (!type) throw new ValidationError(`options.${key} is not an allowed client request property.`);
    const ok = type === "integer" ? Number.isInteger(value) : typeof value === type;
    if (!ok) throw new ValidationError(`options.${key} must be ${type === "integer" ? "an integer" : `a ${type}`}.`);
    if (key === "query_language" && !["kql", "csl", "sql"].includes(String(value).toLowerCase())) throw new ValidationError("options.query_language must be kql, csl, or sql.");
    out[key] = value;
  }
  return out;
}

function validateParameters(parameters) {
  if (parameters === undefined) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new ValidationError(`query-parameters name '${key}' is not a valid identifier.`);
    if (typeof value === "boolean") out[key] = value ? "true" : "false";
    else if (typeof value === "string" || Number.isInteger(value)) out[key] = value;
    else throw new ValidationError(`query-parameters.${key} must be a string, integer, or boolean.`);
  }
  return out;
}

function shapeTable(table, maxRows) {
  const rows = table.rows ?? [];
  return {
    name: table.name,
    kind: table.kind,
    columns: (table.columns ?? []).map((column) => ({ name: column.ColumnName, type: column.ColumnType ?? column.DataType })),
    rows: rows.slice(0, maxRows),
    rowCount: rows.length,
    ...(rows.length > maxRows ? { truncated: true } : {}),
  };
}

function v1Tables(result, maxRows) {
  return (result?.Tables ?? []).map((table) => shapeTable({ name: table.TableName, columns: table.Columns, rows: table.Rows }, maxRows))
    .map(({ kind, ...rest }) => rest);
}

function firstCell(result) {
  const table = result?.Tables?.[0];
  return table?.Rows?.[0]?.[0];
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const commandByName = new Map(COMMANDS.map((command) => [command.name, command]));

/** Commands available with the given settings. */
export function enabledCommands({ enableWrites = false } = {}) {
  return COMMANDS.filter((command) => !command.write || enableWrites);
}

// ---------------------------------------------------------------------------
// Argument parsing and execution, mirroring azure-mcp 3.0.0-beta.49
// (CommandExtensions.TryParseFromDictionary, BaseCommand.HandleException).

/** Unknown arguments: azure-mcp answers with plain text, not an envelope. */
export class RejectedError extends Error {
  constructor(message) {
    super(message);
    this.name = "RejectedError";
  }
}

const MAX_STRING = 1_000_000;
const typesOf = (spec) => (Array.isArray(spec.type) ? spec.type : [spec.type]);
const stripHyphens = (name) => name.replaceAll("-", "").toLowerCase();

/** Find an option by name, case-insensitively, then with hyphens removed. */
function findOption(properties, key) {
  const names = Object.keys(properties);
  const lower = key.toLowerCase();
  return names.find((name) => name.toLowerCase() === lower) ?? names.find((name) => stripHyphens(name) === stripHyphens(key));
}

// azure-mcp ConvertJsonElementToString.
function asText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((item) => (typeof item === "string" ? item : "")).join(" ");
  return JSON.stringify(value);
}

function convert(name, spec, value) {
  const types = typesOf(spec);
  const dotnetType = (base) => (types.includes("null") ? `System.Nullable\`1[${base}]` : base);
  if (types.includes("object")) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
    throw new ValidationError(`--${name} must be an object.`);
  }
  if (types.includes("integer")) {
    const text = asText(value).trim();
    const number = Number.isInteger(value) ? value : /^[+-]?\d+$/.test(text) ? Number(text) : NaN;
    // System.CommandLine parses into Int32.
    if (!Number.isInteger(number) || number > 2_147_483_647 || number < -2_147_483_648) {
      throw new ValidationError(`Cannot parse argument '${asText(value)}' for option '--${name}' as expected type '${dotnetType("System.Int32")}'.`);
    }
    if (spec.minimum !== undefined && number < spec.minimum) throw new ValidationError(`--${name} must be at least ${spec.minimum}.`);
    if (spec.maximum !== undefined && number > spec.maximum) throw new ValidationError(`--${name} must be at most ${spec.maximum}.`);
    return number;
  }
  if (types.includes("boolean")) {
    if (typeof value === "boolean") return value;
    const text = asText(value).trim().toLowerCase();
    if (text === "true" || text === "false") return text === "true";
    throw new ValidationError(`Cannot parse argument '${asText(value)}' for option '--${name}' as expected type '${dotnetType("System.Boolean")}'.`);
  }
  const text = asText(value);
  if (spec.enum && !spec.enum.includes(text.toLowerCase())) throw new ValidationError(`--${name} must be one of: ${spec.enum.join(", ")}`);
  if (text.length > MAX_STRING && name !== "data") throw new ValidationError(`--${name} is too long.`);
  return text;
}

/** Map raw MCP arguments onto a command's options, azure-mcp style. */
export function parseArguments(command, args) {
  if (args === null || args === undefined) args = {};
  if (typeof args !== "object" || Array.isArray(args)) throw new RejectedError("Arguments must be an object.");
  const { properties, required = [] } = command.inputSchema;
  const raw = {};
  const invalid = [];
  for (const [key, value] of Object.entries(args)) {
    const name = findOption(properties, key);
    if (!name) {
      invalid.push(key);
      continue;
    }
    if (value === null || value === undefined) continue;
    raw[name] = value;
  }
  if (invalid.length) throw new RejectedError(`Request rejected due to unknown arguments: ${invalid.join(", ")}`);
  const clean = {};
  for (const [name, value] of Object.entries(raw)) clean[name] = convert(name, properties[name], value);
  const missing = required.filter((name) => clean[name] === undefined || clean[name] === "");
  if (missing.length) throw new ValidationError(`${MISSING_PREFIX}${missing.map((name) => `--${name}`).join(", ")}`);
  return clean;
}

/**
 * Execution context: binds a Kusto client, an ARM client, and settings, and
 * offers the helpers commands use. withSignal() makes a per-call copy.
 */
export class Context {
  constructor({ kusto, arm, config, signal }) {
    this.kusto = kusto;
    this.arm = arm;
    this.config = config;
    this.signal = signal;
  }

  withSignal(signal) {
    return new Context({ kusto: this.kusto, arm: this.arm, config: this.config, signal });
  }

  readOnlyOptions(force = false) {
    if (!force && !this.config.queryReadOnly) return {};
    return this.config.readOnlyHardline ? { request_readonly: true, request_readonly_hardline: true } : { request_readonly: true };
  }

  async clusterUri(a) {
    if (a["cluster-uri"]) return a["cluster-uri"];
    return this.arm.clusterUri({ subscription: a.subscription, cluster: a.cluster, tenant: a.tenant, signal: this.signal });
  }

  async query(a, database, csl) {
    const uri = await this.clusterUri(a);
    return this.kusto.v1("query", uri, { database, csl, options: this.readOnlyOptions(), tenant: a.tenant, signal: this.signal });
  }

  async mgmt(a, database, csl, { forceReadOnly = false } = {}) {
    const uri = await this.clusterUri(a);
    return this.kusto.v1("mgmt", uri, { database, csl, options: this.readOnlyOptions(forceReadOnly), tenant: a.tenant, signal: this.signal });
  }

  /** azure-mcp QueryItemsAsync: validate, sanitize literals, run, shape. */
  async queryItems(a, query) {
    validateQuerySafety(query);
    const result = await this.query(a, a.database, sanitizeStringLiterals(query));
    return toItems(result);
  }
}

/**
 * Run a command and return azure-mcp's response envelope:
 * {status, message, results?, duration}. A rejected call carries a
 * non-enumerable `plainText` instead, which the caller returns as is.
 */
export async function execute(ctx, command, rawArgs, { signal } = {}) {
  const started = Date.now();
  const response = { status: 200, message: "" };
  const callCtx = signal ? ctx.withSignal(signal) : ctx;
  try {
    const args = parseArguments(command, rawArgs);
    if (command.clusterScoped || command.name.startsWith("kusto_cluster")) {
      args.subscription = resolveSubscriptionOption(args.subscription, ctx.config.defaultSubscription);
      if (args.subscription === undefined) delete args.subscription;
    }
    if (command.clusterScoped && !args["cluster-uri"] && (!args.cluster || !args.subscription)) {
      throw new ValidationError("Either --cluster-uri must be provided, or both --subscription and --cluster must be provided.");
    }
    const output = await command.run(callCtx, args);
    if (output && typeof output === "object" && "status" in output && "results" in output) {
      response.status = output.status;
      response.message = output.message ?? "";
      response.results = output.results;
    } else {
      response.results = output;
    }
  } catch (error) {
    if (error instanceof RejectedError) {
      Object.defineProperty(response, "plainText", { value: error.message, enumerable: false });
    } else {
      applyError(response, command, error);
    }
  }
  response.duration = Date.now() - started;
  return response;
}

function applyError(response, command, error) {
  if (error instanceof ValidationError) {
    response.status = error.status;
    response.message = error.message;
    return;
  }
  let status = Number.isInteger(error?.status) && error.status >= 400 ? error.status : statusFor(error);
  // azure-mcp raises Kusto HTTP failures as HttpRequestException without a
  // status code, which its GetStatusCode maps to 503.
  if (command.compat && error?.source === "kusto") status = 503;
  const message = command.errorMessage?.(error) ?? error?.message ?? String(error);
  response.status = status;
  response.message = `${message}. To mitigate this issue, please refer to the troubleshooting guidelines here at ${TROUBLESHOOTING_URL}.`;
  response.results = { message: error?.message ?? String(error), stackTrace: null, type: error?.name && error.name !== "Error" ? error.name : "Exception" };
}

function statusFor(error) {
  if (error?.name === "KeyNotFoundException") return 404;
  return 500;
}

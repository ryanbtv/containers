# kusto-mcp

An Azure Data Explorer (Kusto) MCP server with no npm dependencies. It replaces the `kusto` tool of [azure-mcp](https://github.com/microsoft/mcp) and is built to sit behind the [Bifrost MCP gateway](https://docs.getbifrost.ai/mcp/overview). It speaks MCP over stdio by default, and it can serve a small authenticated streamable-HTTP endpoint for cluster hosting.

Published as `ghcr.io/ryanbtv/kusto-mcp`. Compatible with azure-mcp `3.0.0-beta.49`.

## Compatibility with azure-mcp

The seven azure-mcp Kusto commands keep their exact names, descriptions, input schemas, and result shapes:

| Command | Plane | Kusto request |
| --- | --- | --- |
| `kusto_sample` | Data | `/v1/rest/query`: `['<table>'] \| sample <limit>` (limit 1–10000, default 10) |
| `kusto_query` | Data | `/v1/rest/query`: the KQL, after azure-mcp's safety checks |
| `kusto_cluster_list` | Control | Azure Resource Graph: `Microsoft.Kusto/clusters`, limit 50 |
| `kusto_cluster_get` | Control | Azure Resource Graph, filtered by name |
| `kusto_database_list` | Data | `/v1/rest/mgmt` on `NetDefaultDB`: `.show databases \| project DatabaseName` |
| `kusto_table_list` | Data | `/v1/rest/mgmt`: `.show tables` |
| `kusto_table_schema` | Data | `/v1/rest/query`: `.show table ['<table>'] cslschema` |

The server exposes them two ways, set by `KUSTO_MCP_TOOLS`:

- **`kusto`**: azure-mcp's namespace router, with the same `intent`, `command`, `parameters`, and `learn` inputs, the same learn text, and the same help and missing-option messages. This is the form azure-mcp serves by default.
- **`kusto_*`**: one tool per command, as azure-mcp serves them in all-tools mode.

Every call returns azure-mcp's envelope as JSON text: `{"status","message","results","duration"}`. A validation error has no `results`. Any other error carries `results: {"message","stackTrace","type"}`, and the message ends with azure-mcp's troubleshooting link. A status outside 2xx sets `isError`.

Arguments are parsed the way azure-mcp parses them:

- **Option names:** matched in any case, and also with the hyphens removed, so `clusterUri` and `ResourceGroup` work.
- **Values:** converted to the option's type, so `"limit": "5"` and `"database": 123` work.
- **Unknown arguments:** an unknown argument fails with azure-mcp's plain-text `Request rejected due to unknown arguments: ...`.
- **Router `parameters`:** a `parameters` object wins. Flat arguments are used only when `parameters` is missing or not an object.

Errors also match azure-mcp:

- **Unknown router command:** gets azure-mcp's `The command '...' is not available for the 'kusto' tool.` text.
- **Missing options:** a missing-options error gets the command spec.
- **Kusto HTTP errors:** a Kusto HTTP error on a compatible command is status 503, as in azure-mcp.
- **Invalid cluster URI:** gives a 400 `ArgumentException` that names the `clusterUri` parameter.
- **Missing resource group:** gives a 404.
- **Cluster URIs:** cluster and ingestion URIs end in `/`, as .NET writes them.

Numbers keep their exact JSON text, so a `long` above 2^53 and `1.0E-7` come back as Kusto sent them.

The checks are ports of azure-mcp's code:

- `kusto_query` and `kusto_sample` reject management commands (`.drop`, `.alter`, `.create`, `.delete`, `.set*`, `.append`, `.ingest`, `.purge`, `.execute`) at the start of the query or after `|` or `;`.
- They also reject tautologies such as `or 1==1`, and queries longer than 10,000 characters.
- Table names are validated and escaped as `['name']`.
- Cluster URIs must use HTTPS and one of azure-mcp's Kusto host suffixes, which blocks requests to arbitrary hosts.

The server differs from azure-mcp in these ways:

- **Read-only flag:** every read request also sends `request_readonly: true`, so Kusto itself refuses a write. `KUSTO_QUERY_READONLY=0` turns this off for the compatible commands only. `kusto_command` and `kusto_query_v2` always send it.
- **`isStreamingIngestEnabled`:** reports the cluster's real setting. azure-mcp always reports `false` because of a property-mapping bug.
- **Error types and statuses:** an Entra ID failure is a 401 `MsalServiceException` (azure-mcp most likely reports `AuthenticationFailedException`). A Kusto timeout is a 504 (azure-mcp reports a 500 `TaskCanceledException`).
- **Request identity:** Kusto sees `x-ms-app: kusto-mcp` and client request IDs of the form `KustoMcp.<kind>;<guid>`, not `AzureMCP` and `AzMcp<guid>`. Filters on `.show queries` must use the new values.
- **Cancellation:** a client that disconnects, or sends `notifications/cancelled` over stdio, aborts the HTTP request to Kusto. Kusto may keep running a query it has already started.
- **Tool names behind Bifrost:** Bifrost prefixes every tool with its client name (`<client>-<tool>`, for example `kusto-kusto_query`) and has no setting to turn the prefix off. The arguments and results are unchanged.
- **Subscription default:** the default subscription comes from `AZURE_SUBSCRIPTION_ID`. The server has no Azure CLI profile to read it from.
- **`tenant`:** this option takes a tenant ID or domain. A tenant display name is not resolved.
- **Unknown command:** a router call with an unknown `command` returns azure-mcp's not-found message. The server does not try LLM sampling to guess the command.

## Additional tools

These read tools are listed as separate tools and behind the router:

| Tool | What it does |
| --- | --- |
| `kusto_query_v2` | Runs a query through `/v2/rest/query` with `query-parameters`, allow-listed client request properties (`servertimeout`, `truncationmaxrecords`, the datetime scope, `query_language`, and others), `max-rows`, and every result table with typed columns. The call is read-only, and management commands are refused. A partial failure returns status 206 with `errors`. |
| `kusto_command` | Runs one `.show` management command, such as `.show queries`, `.show ingestion failures`, `.show table T policy retention`, or `.show diagnostics`. The command may pipe into query operators. Anything else is refused. |
| `kusto_database_schema` | Runs `.show database ['D'] schema as json`, either for the whole database or for one `table`. |
| `kusto_function_list` | Runs `.show functions` and returns names, parameters, folders, and doc strings. |
| `kusto_function_get` | Runs `.show function ['F']` and also returns the body. |
| `kusto_principal_details` | Runs `print current_principal_details()` to show which identity the server authenticates as. |

These write tools exist only with `KUSTO_ENABLE_WRITES=1`. They are never put behind the `kusto` router, so a gateway or client can allow or deny each one by name. Writes are never retried.

| Tool | What it does |
| --- | --- |
| `kusto_command_write` | Runs any control command through `/v1/rest/mgmt`. It needs `confirm: true`. Annotated destructive. |
| `kusto_query_cancel` | Runs `.cancel query "<client-request-id>"`, with an optional reason. |
| `kusto_ingest_stream` | Streaming ingestion through `POST /v1/rest/ingest/{db}/{table}` for the text formats `csv`, `tsv`, `scsv`, `sohsv`, `psv`, `json`, and `multijson`. JSON formats need `mapping-name`. It needs `confirm: true`, and the data is capped at `KUSTO_MAX_INGEST_BYTES`. |

## Run

```sh
docker run -i --rm --init \
  -e AZURE_TENANT_ID -e AZURE_CLIENT_ID -e AZURE_CLIENT_SECRET \
  -e AZURE_SUBSCRIPTION_ID \
  ghcr.io/ryanbtv/kusto-mcp:latest
```

Pass each secret with `-e NAME` and no value. The value then comes from your environment and stays off the command line. A `*_FILE` variable reads the value from a mounted file instead.

The service principal needs two grants:

- **Data plane:** `viewer` or a higher role on each database it reads, for example `.add database D viewers ('aadapp=<appId>;<tenantId>')`.
- **Control plane:** `Reader` on the subscription, for `kusto_cluster_list`, `kusto_cluster_get`, and `--cluster` name lookups.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `AZURE_TENANT_ID` | none | Default tenant for tokens. |
| `AZURE_CLIENT_ID` | none | Service principal application ID. |
| `AZURE_CLIENT_SECRET` | none | Service principal secret. |
| `AZURE_CLIENT_SECRET_FILE` | none | File that holds the secret. Used only when `AZURE_CLIENT_SECRET` is unset. |
| `AZURE_SUBSCRIPTION_ID` | none | Default subscription for the control-plane commands and for `--cluster` lookups. |
| `AZURE_AUTHORITY_HOST` | `https://login.microsoftonline.com` | Entra ID authority. |
| `AZURE_RESOURCE_MANAGER_URL` | `https://management.azure.com` | ARM endpoint. The token scope is `<url>/.default`. |
| `KUSTO_MCP_TOOLS` | `both` | `both` serves the router and the flat tools. `namespace` serves the router only, plus any write tools. `all` serves the flat tools only. |
| `KUSTO_ENABLE_WRITES` | off | `1` registers the write tools. |
| `KUSTO_QUERY_READONLY` | on | Sends `request_readonly: true` on every read request. |
| `KUSTO_READONLY_HARDLINE` | off | Also sends `request_readonly_hardline: true`, which disables plugins. |
| `KUSTO_TIMEOUT_MS` | `240000` | Timeout for one Kusto request, the same as azure-mcp. |
| `KUSTO_RETRIES` | `3` | Retries for reads on 429, 503, and connection errors. A timeout, 502, or 504 is never retried, because the query may have run. A `Retry-After` header is honored for up to 10 s. Redirects are refused. |
| `KUSTO_MAX_CONCURRENCY` | `8` | Most Kusto requests in flight at once. |
| `KUSTO_MAX_RESPONSE_BYTES` | `16777216` | Cap on one Kusto response body. A larger response fails with status 413. |
| `KUSTO_MAX_QUERY_LENGTH_V2` | `65536` | Query length cap for `kusto_query_v2`, `kusto_command`, and `kusto_command_write`. The compatible tools keep azure-mcp's 10,000-character cap. |
| `KUSTO_MAX_INGEST_BYTES` | `4194304` | Cap on `kusto_ingest_stream` data. |
| `KUSTO_EXTRA_HOST_SUFFIXES` | none | Comma-separated host suffixes to accept beyond azure-mcp's list. |
| `KUSTO_EXTRA_HOSTS` | none | Comma-separated exact hosts to accept. |
| `KUSTO_ALLOWED_CLUSTERS` | none | Comma-separated exact cluster URIs. When it is set, every other cluster is refused, including ones named through `--cluster`. Any `*.kusto.windows.net` cluster accepts the same token, so this keeps a prompt-injected caller from sending data to a cluster it owns. |
| `KUSTO_SCOPE` | by cloud | Override the Kusto token scope. The default is `https://kusto.kusto.windows.net/.default`, or the China or US Government variant, chosen by host. |
| `KUSTO_LOG_REQUESTS` | off | `1` logs each Kusto request and tool call to stderr, without query text or secrets. |
| `MCP_TRANSPORT` | `stdio` | `http` serves streamable HTTP instead. |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | HTTP listen address. |
| `MCP_HTTP_TOKEN` | none | Required in HTTP mode, with at least 16 characters. `MCP_HTTP_TOKEN_FILE` reads it from a file. |

## HTTP mode

`MCP_TRANSPORT=http` serves a stateless subset of streamable HTTP, the same as `netbox-mcp`.

- `POST /mcp` takes one JSON-RPC message and answers with JSON. It needs `Authorization: Bearer $MCP_HTTP_TOKEN`.
- A notification gets `202`. `GET /mcp` and other methods get `405`.
- `GET /health` answers `{"ok":true}` without authentication. Use it for a Kubernetes probe.
- Receiving a request is limited to 60 s. Answering it is not limited, so a long query is not cut off. A malformed or aborted request gets a 400 and never stops the server.
- A client that disconnects cancels its call.

### Behind Bifrost

Register the server as an HTTP MCP client, and keep tools out of LLM requests unless you want them injected:

```yaml
bifrost:
  client:
    mcpDisableAutoToolInject: true
  mcp:
    enabled: true
    clientConfigs:
      - name: kusto
        connectionType: http
        httpConfig:
          url: http://kusto-mcp.kusto-mcp.svc.cluster.local:8080/mcp
        authType: headers
        headers:
          Authorization: env.KUSTO_MCP_AUTHORIZATION # "Bearer <MCP_HTTP_TOKEN>"
        toolsToExecute: ["*"]
        endpointSlug: kusto
```

Bifrost then serves the tools at `/mcp` and `/mcp/kusto` as `kusto-kusto`, `kusto-kusto_query`, and so on.

## Tests

Tests run in the image build and in the repository suite (`node scripts/test.mjs`, component `kusto-mcp`). They use an in-process fake of Entra ID, Azure Resource Manager, and a Kusto cluster, and need no network. `test/fixtures/` holds the learn output captured from azure-mcp `3.0.0-beta.49`, and `compat.test.mjs` checks the server against it byte for byte.

```sh
cd images/kusto-mcp && node --test test/*.test.mjs
```

## Changelog

- 1.0.0: First release. Provides the seven azure-mcp-compatible commands, the router, six read tools, and three write tools behind a flag.

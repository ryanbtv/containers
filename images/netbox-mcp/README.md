# netbox-mcp

A NetBox MCP server with no npm dependencies. It speaks MCP over stdio by default, and it can serve a small streamable-HTTP endpoint for cluster hosting. It covers the NetBox REST API and read-only GraphQL. A committed schema catalog lets it validate filters and write payloads before it sends anything.

Published as `ghcr.io/ryanbtv/netbox-mcp`. Built against NetBox 4.6.0.

## Run

```sh
docker run -i --rm --init \
  -e NETBOX_URL=https://netbox.example.com \
  -e NETBOX_TOKEN \
  ghcr.io/ryanbtv/netbox-mcp:latest
```

Pass `-e NETBOX_TOKEN` without a value. The token then comes from your environment and stays off the command line. To use a file instead, mount it read-only and set `NETBOX_TOKEN_FILE`:

```sh
docker run -i --rm --init \
  -e NETBOX_URL=https://netbox.example.com \
  -v /path/to/netbox-token:/run/secrets/netbox-token:ro \
  -e NETBOX_TOKEN_FILE=/run/secrets/netbox-token \
  ghcr.io/ryanbtv/netbox-mcp:latest
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `NETBOX_URL` | none | NetBox origin, such as `https://netbox.example`. A trailing `/api/` is accepted. Tool calls fail without it. `tools/list` still works. |
| `NETBOX_TOKEN` | none | API token. A v2 `nbt_` token is sent as `Bearer`; an older token is sent as `Token`. |
| `NETBOX_TOKEN_FILE` | none | File that holds the token. Used only when `NETBOX_TOKEN` is unset. |
| `NETBOX_VERIFY_TLS` | `1` | `0` turns off certificate checks for the whole process. Prefer `NODE_EXTRA_CA_CERTS` for a private CA. |
| `NETBOX_MAX_CONCURRENCY` | `3` | Most NetBox requests in flight at once, across all tool calls. The live backend failed at about 45. |
| `NETBOX_TIMEOUT_MS` | `30000` | Timeout for one read, and for the read-only POSTs (GraphQL and `render-config`). |
| `NETBOX_WRITE_TIMEOUT_MS` | `120000` | Timeout for one POST, PATCH, PUT, or DELETE write. See [Timeouts](#timeouts). |
| `NETBOX_RETRIES` | `3` | Retries for transient failures. See [Retries](#retries). |
| `NETBOX_MAX_OUTPUT_BYTES` | `100000` | Cap on one tool result. |
| `NETBOX_READ_ONLY` | off | `1` hides the write and delete tools and refuses calls to them. |
| `NETBOX_ALLOW_ADMIN_WRITES` | off | `1` allows writes to admin types. See [Admin types](#admin-types). |
| `NETBOX_LOG_REQUESTS` | off | `1` logs each request and tool call to stderr, without the token. |
| `NETBOX_CATALOG` | `/app/catalog.json` | Alternative catalog path. |
| `MCP_TRANSPORT` | `stdio` | `http` serves streamable HTTP instead. |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | HTTP listen address. |
| `MCP_HTTP_TOKEN` | none | Required in HTTP mode, with at least 16 characters. The server refuses to start without it. |

## Tools

| Tool | Class | What it does |
| --- | --- | --- |
| `list_object_types` | read | Catalog types grouped by app. Does not call NetBox. |
| `describe_object_type` | read | Writable fields with type, required flag, enum choices, and ref target. Also list filters, readable fields, and special endpoints. `ops` lists only what this server allows. Enums over 40 values show the first 25 unless `full_enums: true`. |
| `get_objects` | read | Filtered list. Pages automatically up to 5000 rows, 1000 per request. Supports `fields`, `brief`, `omit`, `ordering`, `q`, `offset`, and cursor `start`. |
| `get_object` | read | One object by id. |
| `count_objects` | read | Up to 50 type and filter counts in one call, each with `limit=1&fields=id`. |
| `search_objects` | read | Global `q` across 16 common types, or the types you give. |
| `get_changelog` | read | `core/object-changes` by type, id, user, request id, action, or time. `data` can be `diff` or `full`. |
| `get_available_resources` | read | Free IPs, prefixes, VLANs, or ASNs. |
| `trace_path` | read | Cable trace, or paths through a pass-through port or circuit termination. |
| `get_rack_elevation` | read | Occupied rack units for one face. |
| `graphql_query` | read | Read-only GraphQL. Mutations and subscriptions are refused. |
| `get_rendered_config` | read | `render-config` for a device or VM. NetBox serves it as a POST, but it writes nothing. |
| `create_objects` | write | One object or a bulk array of up to 500. `fields` trims the response. |
| `update_objects` | write | PATCH one object, or a bulk array with ids. `fields` trims the response. |
| `allocate_available` | write | POST to an `available-*` endpoint. |
| `delete_objects` | dangerous | Up to 100 ids, sent in sequential batches of 25. `confirm` must equal the number of ids. Reports cascades. |

Each write and delete tool takes `dry_run: true`. A dry run checks the payload against the catalog: the type, the operation, unknown fields, required fields, value types, and enum values. It returns the exact method, path, and body, and sends nothing. A live write returns the resulting objects and the NetBox `X-Request-ID`. Use that id with `get_changelog`.

`delete_objects` reads the targets first. If any id is missing, it deletes nothing. It returns the brief form of each deleted object. More than 25 ids go out as batches of 25, one after another, each its own NetBox transaction, so the whole call is not atomic. When a batch fails, the call stops and the error lists the ids deleted, the request ids, the ids in the failed batch, and the ids not attempted. One batch returns `request_id`; several return `request_ids`.

NetBox deletes more than the named objects. On 2026-10-02, deleting 24 devices also deleted 276 interfaces and 218 MAC addresses, plus modules, console and power ports, and inventory items. Every delete dry run and live result therefore carries a `cascade` note. For five types, a dry run also returns `cascade_counts`: read-only counts of the main dependents, each with the filter used and its effect. The counts use at most 5 `limit=1` calls and go through the normal concurrency limit. A failed count shows an `error` and does not fail the dry run.

| Type | Counted dependents |
| --- | --- |
| `dcim.devices` | Interfaces, IP addresses, MAC addresses, modules, and inventory items, all deleted. Ports, outlets, and bays are deleted too, but not counted. |
| `dcim.interfaces` | IP and MAC addresses (deleted), child interfaces (block the delete), and LAG members (unassigned). |
| `dcim.virtual-chassis` | Member devices (unassigned, not deleted). |
| `ipam.vlan-groups` | VLANs (block the delete). |
| `dcim.sites` | Devices, racks, and VLANs (block the delete), locations (deleted), and prefixes (may be deleted). |

The rules come from the NetBox 4.6.0 models. An interface's IP addresses, MAC addresses, FHRP assignments, and tunnel and L2VPN terminations are generic relations, so NetBox deletes them with the interface instead of unassigning them. NetBox's bulk delete removes one object at a time. A parent interface therefore fails even when its child is in the same call.

`update_objects` sends a PATCH, so only the given fields change. NetBox 4.6 also merges `custom_fields` on update: it starts from the stored values and overlays the keys you send. Send only the custom-field keys you change. An unknown custom-field name is rejected.

The full `tools/list` response is about 9.9 KB, or 6.8 KB in read-only mode.

### Filters

`get_objects` and `count_objects` check filter names and lookup suffixes against the catalog before they call NetBox. An error names the supported lookups in words, such as `lag_id__n (not equal)`. A Django-style lookup such as `__isnull`, `__exact`, or `__contains` gets the NetBox equivalent. A ref filter accepts `null` for an unset value, for example `{"lag_id": null}`.

The NetBox REST API has no multi-hop filters, such as `device__site_id` on interfaces. The error says so and points at a direct filter on the type when one exists (`site_id`, `device_status`), at the base field's `*_id` filter, or at `graphql_query`.

### Output shaping

By default, results drop `url`, `display_url`, `null`, empty strings, and empty `tags` and `custom_fields`. Choice objects such as `{"value":"active","label":"Active"}` become `"active"`. Keys inside `custom_fields` are kept with `null` values, so an unset custom field stays visible and differs from one the type lacks. Pass `raw: true` for NetBox's exact JSON.

When `fields` is given, each related object comes back brief: `id`, `display`, `name` when it differs from `display`, and `slug`. Lists of related objects, such as `tags`, are briefed the same way. `raw: true` turns this off. On `create_objects` and `update_objects`, `fields` keeps `id` and the named top-level fields from the response, then applies the same rules. A field the type cannot return produces a warning.

List results always carry `count`, the total number of matches, and `returned`. When output exceeds the cap, trailing rows are dropped and a `truncated` block gives `next_offset` or `next_start`.

### Retries

GET, HEAD, and OPTIONS retry on 429, 502, 503, 504, connection resets, and timeouts. The backoff has jitter and a 3-second cap. POST, PATCH, PUT, and DELETE never retry. A gateway error can arrive after NetBox has already committed the change, and a repeated bulk DELETE fails on ids that are already gone. The error says so. The two read-only POSTs, GraphQL and `render-config`, do retry.

### Timeouts

Reads time out after `NETBOX_TIMEOUT_MS` (30 s). Writes time out after `NETBOX_WRITE_TIMEOUT_MS` (120 s), because a bulk write can run longer and cannot be retried. On 2026-10-02, a 24-device bulk DELETE timed out at 30 s, and NetBox finished it seconds later.

When a write times out, fails with a gateway status, or loses its connection after it was sent, the outcome is unknown. The error then says that the write may have been applied. It gives the request start time as an ISO timestamp, the type, and the action, for example `get_changelog since="2026-10-02T18:04:11.512Z" object_type="dcim.devices" action="delete"`. Check that before you repeat the write. The start time comes from this host's clock. A refused connection or a DNS failure means the request never left, and the error does not carry the note.

### Admin types

Writes to `users.*`, `core.*`, `extras.scripts`, `extras.event-rules`, and `extras.webhooks` are refused unless `NETBOX_ALLOW_ADMIN_WRITES=1`. These types hold accounts, tokens, permissions, data sources, and jobs, or they can run code or send data off the host. No tool exposes the background-task or sync actions. `describe_object_type` shows only `list get` for a refused type, with a `writes` reason. `NETBOX_READ_ONLY=1` does the same for every type.

## Schema catalog

`catalog.json` is generated from the NetBox OpenAPI schema and committed. The server loads it once, on first use. On the first NetBox call, the server compares the catalog version with `netbox-version` from `/api/status/`. If they differ, every result carries a warning, and filter and field checks become warnings instead of errors.

Regenerate it on the host after a NetBox upgrade:

```sh
cd images/netbox-mcp
node scripts/build-catalog.mjs --schema /path/to/schema.json
NETBOX_URL=https://netbox.example.com NETBOX_TOKEN_FILE=/path/to/netbox-token \
  node scripts/build-catalog.mjs --live
```

The generator is not shipped in the image.

## HTTP mode

`MCP_TRANSPORT=http` serves a stateless subset of streamable HTTP. It does not use sessions or SSE.

- `POST /mcp` takes one JSON-RPC message and answers with JSON. It needs `Authorization: Bearer $MCP_HTTP_TOKEN`.
- A notification gets `202`.
- `GET /health` answers `{"ok":true}` without authentication. Use it for a Kubernetes probe.

The image has no `HEALTHCHECK`. The default stdio mode has no port to probe, and a check that always passes would hide failures.

## Tests

Tests run in the image build and in the repository suite (`node scripts/test.mjs`, component `netbox-mcp`). They use an in-process fake NetBox and need no network.

```sh
cd images/netbox-mcp && node --test test/*.test.mjs
```

## Changelog

The `VERSION` file sets the `v<x.y.z>` image tag. The tag is pushed when the change reaches `main`. Pin a consumer to a new tag only after that build publishes it; a launcher that uses `--pull=missing` fails on a tag that does not exist yet.

### 1.1.0 (2026-10-02)

Fixes from the first full NetBox rebuild (about 100 deletes, 300 updates, and 150 creates).

- Writes get their own timeout, `NETBOX_WRITE_TIMEOUT_MS`, default 120 s. Reads keep 30 s.
- A write with an unknown outcome says it may have been applied and gives the `get_changelog` arguments to check it, including the request start time.
- `delete_objects` sends more than 25 ids as sequential batches of 25 and reports a partial failure exactly. Writes are still never retried.
- Delete dry runs and live results carry a `cascade` note. Dry runs on devices, interfaces, virtual chassis, VLAN groups, and sites add read-only `cascade_counts`.
- Filter errors name the supported lookups in words, map Django-style lookups, and explain that multi-hop filters are not supported.
- `describe_object_type` lists only the operations this server allows. It cuts enums over 40 values to the first 25 unless `full_enums: true`.
- With `fields`, related objects come back brief. `create_objects` and `update_objects` accept `fields`.
- Non-raw output keeps `custom_fields` keys whose value is `null`. The `update_objects` description says that NetBox merges `custom_fields` on PATCH.

### 1.0.0 (2026-10-02)

First release.

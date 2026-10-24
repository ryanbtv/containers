// MCP tool definitions and handlers.
import { CatalogError, checkFilters, describeFieldText, loadCatalog, resolveType, validatePayload } from "./catalog.mjs";
import { brief, capList, capText, maybeShape, project, shape, shapeRow } from "./shape.mjs";

const PAGE_MAX = 1000;
const GET_MAX = 5000;
const BULK_MAX = 500;
const DELETE_MAX = 100;
// Bulk deletes go out in batches this size, one after another, so each
// request stays well inside the write timeout. A batch is never retried.
const DELETE_BATCH = 25;

// Writes to these types need NETBOX_ALLOW_ADMIN_WRITES=1. users/core cover
// accounts, tokens, permissions, data sources, and jobs. The extras entries
// can run code or send data off-box (scripts, event rules, webhooks).
const ADMIN_APPS = new Set(["users", "core"]);
const ADMIN_TYPES = new Set(["extras.scripts", "extras.event-rules", "extras.webhooks"]);

const DEFAULT_SEARCH_TYPES = [
  "dcim.devices", "dcim.sites", "dcim.racks", "dcim.interfaces", "dcim.device-types", "dcim.cables",
  "ipam.ip-addresses", "ipam.prefixes", "ipam.vlans", "ipam.vrfs", "ipam.ip-ranges",
  "virtualization.virtual-machines", "virtualization.clusters", "circuits.circuits",
  "tenancy.tenants", "tenancy.contacts",
];

const ALLOCATIONS = {
  "ipam.prefixes": { ips: ["available-ips", "ipam.ip-addresses", "address"], prefixes: ["available-prefixes", "ipam.prefixes", "prefix"] },
  "ipam.ip-ranges": { ips: ["available-ips", "ipam.ip-addresses", "address"] },
  "ipam.vlan-groups": { vlans: ["available-vlans", "ipam.vlans", "vid"] },
  "ipam.asn-ranges": { asns: ["available-asns", "ipam.asns", "asn"] },
};

// What NetBox 4.6 does to dependents on delete, from its model on_delete rules
// and generic relations. counts: [type, filter, effect], at most
// CASCADE_COUNT_MAX per dry run.
const CASCADE_COUNT_MAX = 5;
export const CASCADES = {
  "dcim.devices": {
    note: "NetBox also deletes each device's components (interfaces, console, console-server, and power ports, power outlets, front and rear ports, device bays, module bays), its modules, and its inventory items. Deleting an interface also deletes the IP addresses, MAC addresses, FHRP group assignments, and tunnel and L2VPN terminations assigned to it, and its cable terminations. A virtual-chassis master cannot be deleted.",
    counts: [
      ["dcim.interfaces", "device_id", "deleted"],
      ["ipam.ip-addresses", "device_id", "deleted"],
      ["dcim.mac-addresses", "device_id", "deleted"],
      ["dcim.modules", "device_id", "deleted"],
      ["dcim.inventory-items", "device_id", "deleted"],
    ],
  },
  "dcim.interfaces": {
    note: "NetBox also deletes the IP addresses, MAC addresses, FHRP group assignments, and tunnel and L2VPN terminations assigned to each interface, and its cable termination. Child interfaces block the delete, even in the same call, because NetBox deletes one object at a time; delete or unparent them first. LAG and bridge members are unassigned.",
    counts: [
      ["ipam.ip-addresses", "interface_id", "deleted"],
      ["dcim.mac-addresses", "interface_id", "deleted"],
      ["dcim.interfaces", "parent_id", "blocks the delete"],
      ["dcim.interfaces", "lag_id", "unassigned"],
    ],
  },
  "dcim.virtual-chassis": {
    note: "Member devices are not deleted; NetBox removes them from the chassis.",
    counts: [["dcim.devices", "virtual_chassis_id", "unassigned"]],
  },
  "ipam.vlan-groups": {
    note: "VLANs in a group block the delete. Move or delete them first.",
    counts: [["ipam.vlans", "group_id", "blocks the delete"]],
  },
  "dcim.sites": {
    note: "Devices, racks, and VLANs at a site block the delete. Locations at the site are deleted. Prefixes and VLAN groups scoped to the site or its locations are generic relations and may be deleted with it.",
    counts: [
      ["dcim.devices", "site_id", "blocks the delete"],
      ["dcim.racks", "site_id", "blocks the delete"],
      ["ipam.vlans", "site_id", "blocks the delete"],
      ["dcim.locations", "site_id", "deleted"],
      ["ipam.prefixes", "site_id", "may be deleted"],
    ],
  },
};

function cascadeNote(key) {
  const general = "would_delete lists only the named objects. NetBox may also delete objects that depend on them, unassign others, or refuse when another object still references them.";
  return CASCADES[key] ? `${general} ${CASCADES[key].note}` : general;
}

export const INSTRUCTIONS = [
  "NetBox DCIM/IPAM over REST. Type names look like dcim.devices or ipam.ip-addresses.",
  "Performance: pass fields=[...] (or brief=true) to get_objects; use count_objects for totals, never page length; use graphql_query for multi-hop reads in one call; search_objects for a global lookup.",
  "Writes: call describe_object_type first, run with dry_run=true, then live. delete_objects needs confirm=<number of ids>. A write that times out may still have been applied; check get_changelog before repeating it.",
  "Output strips url/display_url, nulls, empty strings, empty tags, and collapses {value,label} choices to value; custom_fields keeps unset keys as null. With fields=, related objects come back as {id,display,name,slug}. raw=true returns NetBox's exact JSON.",
].join("\n");

class ToolError extends Error {}

const str = (description) => ({ type: "string", description });
const int = (description, extra = {}) => ({ type: "integer", description, ...extra });
const bool = (description) => ({ type: "boolean", description });
const TYPE = str("Object type, e.g. dcim.devices (list_object_types)");
const RAW = bool("Unshaped NetBox JSON");
const FIELDS = { type: "array", items: { type: "string" }, description: "Return only these fields; related objects come back brief unless raw" };
const DRY = bool("Validate and return the request without sending");
const ID = int("Object id", { minimum: 1 });
const DATA = { anyOf: [{ type: "object" }, { type: "array", items: { type: "object" } }] };

export const TOOL_DEFS = [
  {
    name: "list_object_types", class: "read",
    description: "List NetBox object types from the schema catalog, grouped by app.",
    inputSchema: { type: "object", properties: { app: str("Only this app, e.g. ipam") } },
  },
  {
    name: "describe_object_type", class: "read",
    description: "Writable fields (type, required, enum choices, ref target), list filters, readable fields, and special endpoints for one type. ops shows only what this server allows.",
    inputSchema: {
      type: "object", required: ["type"],
      properties: {
        type: TYPE,
        sections: { type: "array", items: { enum: ["fields", "filters", "read", "special"] }, description: "Default all" },
        full_enums: bool("List every enum value; by default enums over 40 values are cut short"),
      },
    },
  },
  {
    name: "get_objects", class: "read",
    description: "List objects of one type with filters. Pages automatically up to limit (max 5000). Returns count (total matches) and returned.",
    inputSchema: {
      type: "object", required: ["type"],
      properties: {
        type: TYPE,
        filters: { type: "object", description: "NetBox filters, e.g. {\"site\":\"dc1\",\"status\":[\"active\"],\"name__ic\":\"sw\"}" },
        q: str("Free-text search"),
        fields: FIELDS,
        brief: bool("Minimal representation"),
        omit: { type: "array", items: { type: "string" }, description: "Fields to drop server-side" },
        ordering: str("e.g. name or -id"),
        limit: int("Default 50, max 5000", { minimum: 1, maximum: GET_MAX }),
        offset: int("Row offset", { minimum: 0 }),
        start: int("Cursor: id >= start, ordered by id (faster for deep paging)", { minimum: 0 }),
        raw: RAW,
      },
    },
  },
  {
    name: "get_object", class: "read",
    description: "Get one object by id.",
    inputSchema: {
      type: "object", required: ["type", "id"],
      properties: { type: TYPE, id: ID, fields: FIELDS, brief: bool("Minimal representation"), raw: RAW },
    },
  },
  {
    name: "count_objects", class: "read",
    description: "Count matches for one or more type+filter queries in one call.",
    inputSchema: {
      type: "object", required: ["queries"],
      properties: {
        queries: {
          type: "array", maxItems: 50,
          items: { type: "object", required: ["type"], properties: { type: TYPE, filters: { type: "object" }, q: str("Free-text search") } },
        },
      },
    },
  },
  {
    name: "search_objects", class: "read",
    description: "Global free-text search across common types (or the given types). Returns brief hits per type.",
    inputSchema: {
      type: "object", required: ["q"],
      properties: {
        q: str("Search text"),
        types: { type: "array", items: { type: "string" }, description: "Types to search; default devices, sites, racks, interfaces, IPs, prefixes, VLANs, VMs, circuits, tenants, ..." },
        limit: int("Hits per type, default 5, max 50", { minimum: 1, maximum: 50 }),
      },
    },
  },
  {
    name: "get_changelog", class: "read",
    description: "Read the change log (core.object-changes), newest first.",
    inputSchema: {
      type: "object",
      properties: {
        object_type: str("Catalog type (dcim.devices) or content type (dcim.device)"),
        object_id: int("Changed object id"),
        user: str("User name"),
        request_id: str("Request UUID; groups one API call"),
        action: { enum: ["create", "update", "delete"] },
        since: str("ISO time, inclusive"),
        until: str("ISO time, inclusive"),
        q: str("Search object_repr"),
        data: { enum: ["none", "diff", "full"], description: "Include changed data; default none" },
        limit: int("Default 25, max 1000", { minimum: 1, maximum: 1000 }),
        offset: int("Row offset", { minimum: 0 }),
      },
    },
  },
  {
    name: "get_available_resources", class: "read",
    description: "List free IPs, prefixes, VLANs, or ASNs in a prefix, IP range, VLAN group, or ASN range. Read-only.",
    inputSchema: {
      type: "object", required: ["type", "id"],
      properties: {
        type: { enum: Object.keys(ALLOCATIONS) }, id: ID,
        kind: { enum: ["ips", "prefixes", "vlans", "asns"], description: "Needed only for ipam.prefixes (default ips)" },
        limit: int("Default 50, max 1000", { minimum: 1, maximum: 1000 }),
      },
    },
  },
  {
    name: "trace_path", class: "read",
    description: "Trace the cable path from an interface, console/power port, or power feed; or list paths through a front/rear port or circuit termination.",
    inputSchema: { type: "object", required: ["type", "id"], properties: { type: TYPE, id: ID, raw: RAW } },
  },
  {
    name: "get_rack_elevation", class: "read",
    description: "Rack units for one face with the device in each. Occupied units only unless include_empty.",
    inputSchema: {
      type: "object", required: ["id"],
      properties: { id: int("Rack id", { minimum: 1 }), face: { enum: ["front", "rear"] }, include_empty: bool("Include empty units") },
    },
  },
  {
    name: "graphql_query", class: "read",
    description: "Run a read-only GraphQL query (best for multi-hop reads). Mutations are refused.",
    inputSchema: { type: "object", required: ["query"], properties: { query: str("GraphQL query"), variables: { type: "object" } } },
  },
  {
    name: "get_rendered_config", class: "read",
    description: "Render the assigned config template for a device or VM. NetBox POSTs but writes nothing.",
    inputSchema: {
      type: "object", required: ["type", "id"],
      properties: { type: { enum: ["dcim.devices", "virtualization.virtual-machines"] }, id: ID },
    },
  },
  {
    name: "create_objects", class: "write",
    description: "Create one object or a bulk array (max 500). Validated against the catalog; dry_run returns the request only. fields trims the response.",
    inputSchema: { type: "object", required: ["type", "data"], properties: { type: TYPE, data: DATA, dry_run: DRY, fields: FIELDS, raw: RAW } },
  },
  {
    name: "update_objects", class: "write",
    description: "PATCH one object (id + data) or many (data array, each with id; max 500). Only given fields change. custom_fields merges: send only the keys you change. fields trims the response.",
    inputSchema: { type: "object", required: ["type", "data"], properties: { type: TYPE, id: ID, data: DATA, dry_run: DRY, fields: FIELDS, raw: RAW } },
  },
  {
    name: "allocate_available", class: "write",
    description: "Allocate the next free IP(s), prefix(es), VLAN(s), or ASN(s). data: object or array of objects, e.g. {\"description\":\"x\"} or [{\"prefix_length\":28}].",
    inputSchema: {
      type: "object", required: ["type", "id"],
      properties: {
        type: { enum: Object.keys(ALLOCATIONS) }, id: ID,
        kind: { enum: ["ips", "prefixes", "vlans", "asns"], description: "Needed only for ipam.prefixes (default ips)" },
        data: DATA, dry_run: DRY, raw: RAW,
      },
    },
  },
  {
    name: "delete_objects", class: "dangerous",
    description: "Delete objects by id (max 100, sent in batches of 25). confirm must equal the number of ids. NetBox cascades to dependents; dry_run reports them. Returns what was deleted.",
    inputSchema: {
      type: "object", required: ["type", "ids", "confirm"],
      properties: {
        type: TYPE,
        ids: { anyOf: [{ type: "integer" }, { type: "array", items: { type: "integer" }, maxItems: DELETE_MAX }] },
        confirm: int("Must equal the number of ids"),
        dry_run: DRY,
      },
    },
  },
];

export function listTools({ readOnly = false } = {}) {
  return TOOL_DEFS
    .filter((tool) => !readOnly || tool.class === "read")
    .map(({ name, description, inputSchema }) => ({ name, description, inputSchema: { additionalProperties: false, ...inputSchema } }));
}

function asList(value) {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map(String).join(",");
  return String(value);
}

export class Tools {
  constructor({ client, catalogPath, readOnly = false, allowAdminWrites = false, maxOutputBytes = 100_000 }) {
    this.client = client;
    this.catalogPath = catalogPath;
    this.readOnly = readOnly;
    this.allowAdminWrites = allowAdminWrites;
    this.maxOutputBytes = maxOutputBytes;
    this.versionCheck = undefined;
  }

  get catalog() {
    return loadCatalog(this.catalogPath);
  }

  type(name) {
    try {
      return resolveType(this.catalog, name);
    } catch (error) {
      if (error instanceof CatalogError) throw new ToolError(error.message);
      throw error;
    }
  }

  // Compares the catalog with the live NetBox once. Never blocks a call.
  async versionWarnings() {
    this.versionCheck ??= this.client.get("/api/status/").then(
      ({ data }) => {
        const live = data?.["netbox-version"];
        const built = this.catalog.data.netbox_version;
        this.versionMismatch = Boolean(live && live !== built);
        return this.versionMismatch
          ? [`catalog was built from NetBox ${built}, server runs ${live}; field and filter checks may be stale (only warnings now)`]
          : [];
      },
      () => {
        this.versionCheck = undefined;
        return [];
      },
    );
    return await this.versionCheck;
  }

  async call(name, args = {}) {
    const def = TOOL_DEFS.find((tool) => tool.name === name);
    if (!def) throw new ToolError(`unknown tool: ${name}`);
    if (this.readOnly && def.class !== "read") throw new ToolError(`${name} is disabled: NETBOX_READ_ONLY=1`);
    if (args === null || typeof args !== "object" || Array.isArray(args)) throw new ToolError("arguments must be an object");
    const handler = this[`tool_${name}`];
    return await handler.call(this, args);
  }

  out(value) {
    return capText(JSON.stringify(value), this.maxOutputBytes);
  }

  needsNetBox() {
    this.client.assertConfigured();
  }

  // ---- read tools ----------------------------------------------------------

  async tool_list_object_types({ app }) {
    const data = this.catalog.data;
    const grouped = {};
    const readOnlyTypes = [];
    for (const [key, type] of Object.entries(data.types)) {
      const [typeApp, resource] = key.split(".");
      if (app && typeApp !== app) continue;
      (grouped[typeApp] ??= []).push(resource);
      if (!type.ops.includes("create")) readOnlyTypes.push(key);
    }
    if (app && !grouped[app]) throw new ToolError(`unknown app "${app}"; apps: ${[...new Set(Object.keys(data.types).map((k) => k.split(".")[0]))].join(", ")}`);
    const writes = this.readOnly
      ? "Writes are disabled (NETBOX_READ_ONLY=1)."
      : this.allowAdminWrites ? "" : "Writes to users.*, core.*, extras.scripts, extras.event-rules, and extras.webhooks are refused (NETBOX_ALLOW_ADMIN_WRITES).";
    return this.out({
      netbox_version: data.netbox_version,
      count: Object.values(grouped).reduce((sum, list) => sum + list.length, 0),
      types: grouped,
      read_only_types: readOnlyTypes,
      note: `Type name is <app>.<resource>. Every other type supports list/get/create/update/delete and bulk. ${writes}`.trim(),
    });
  }

  async tool_describe_object_type({ type: name, sections, full_enums: fullEnums = false }) {
    const type = this.type(name);
    const want = new Set(sections?.length ? sections : ["fields", "filters", "read", "special"]);
    const refusal = this.writeRefusal(type);
    const ops = refusal ? type.ops.filter((op) => op === "list" || op === "get") : type.ops;
    const out = { type: type.key, model: type.model, content_type: type.ct, path: type.path, ops: ops.join(" ") };
    if (refusal && ops.length < type.ops.length) out.writes = `refused: ${refusal}`;
    if (want.has("fields") && type.fields) {
      out.fields = Object.fromEntries(Object.entries(type.fields).map(([field, spec]) => [field, describeFieldText(spec, { fullEnums })]));
    }
    if (want.has("filters")) {
      out.filters = type.filters;
      out.filter_lookups = Object.fromEntries(Object.entries(this.catalog.data.lookups).map(([code, list]) => [`:${code}`, list]));
      out.filter_note = "name:s means name plus name__ic, name__n, ...; values may be arrays (OR). Ref filters take slug (site=) or id (site_id=); null matches an unset ref. No multi-hop filters (device__site_id); use graphql_query.";
    }
    if (want.has("read")) out.readable_fields = type.read;
    if (want.has("special") && type.special) {
      out.special = Object.fromEntries(Object.entries(type.special).map(([segment, spec]) => [segment, spec.m.join(" ")]));
    }
    return this.out(out);
  }

  filterQuery(type, filters, warnings) {
    if (filters !== undefined && (filters === null || typeof filters !== "object" || Array.isArray(filters))) {
      throw new ToolError("filters must be an object");
    }
    const errors = checkFilters(this.catalog, type, filters);
    if (errors.length) {
      if (this.versionMismatch) warnings.push(...errors);
      else throw new ToolError(`${errors.join("; ")}. See describe_object_type sections=["filters"].`);
    }
    return { ...(filters ?? {}) };
  }

  async tool_get_objects(args) {
    this.needsNetBox();
    const type = this.type(args.type);
    if (!type.ops.includes("list")) throw new ToolError(`${type.key} cannot be listed`);
    const warnings = await this.versionWarnings();
    const limit = Math.min(Math.max(1, args.limit ?? 50), GET_MAX);
    const base = {
      ...this.filterQuery(type, args.filters, warnings),
      q: args.q,
      ordering: args.ordering,
      brief: args.brief ? 1 : undefined,
      fields: asList(args.fields),
      omit: asList(args.omit),
    };
    let rows = [];
    let count;
    const cursor = args.start !== undefined;
    const offset = args.offset ?? 0;
    if (cursor) {
      if (args.offset !== undefined) throw new ToolError("use offset or start, not both");
      const counting = this.client.get(type.path, { ...base, ordering: undefined, brief: undefined, omit: undefined, fields: "id", limit: 1 });
      let start = args.start;
      while (rows.length < limit) {
        const pageSize = Math.min(PAGE_MAX, limit - rows.length);
        const { data } = await this.client.get(type.path, { ...base, start, limit: pageSize });
        rows.push(...data.results);
        if (data.results.length < pageSize || !data.next) break;
        start = Number(data.results.at(-1).id) + 1;
      }
      count = (await counting).data.count;
    } else {
      const firstSize = Math.min(PAGE_MAX, limit);
      const { data } = await this.client.get(type.path, { ...base, limit: firstSize, offset });
      count = data.count;
      rows = data.results;
      const end = Math.min(offset + limit, count ?? 0);
      const pages = [];
      for (let next = offset + firstSize; next < end && rows.length === firstSize; next += PAGE_MAX) {
        pages.push(this.client.get(type.path, { ...base, limit: Math.min(PAGE_MAX, end - next), offset: next }));
      }
      for (const page of await Promise.all(pages)) rows.push(...page.data.results);
    }
    const envelope = { type: type.key, count, returned: rows.length };
    if (cursor) {
      envelope.start = args.start;
      if (rows.length === limit && rows.length) envelope.next_start = Number(rows.at(-1).id) + 1;
    } else {
      envelope.offset = offset;
      if (offset + rows.length < (count ?? 0)) envelope.next_offset = offset + rows.length;
    }
    if (warnings.length) envelope.warnings = warnings;
    envelope.results = rows.map((row) => shapeRow(row, { raw: args.raw, fields: args.fields }));
    return capList(envelope, this.maxOutputBytes, { offset, cursor });
  }

  async tool_get_object(args) {
    this.needsNetBox();
    const type = this.type(args.type);
    if (!Number.isInteger(args.id)) throw new ToolError("id must be an integer");
    const warnings = await this.versionWarnings();
    const { data } = await this.client.get(`${type.path}${args.id}/`, {
      fields: asList(args.fields),
      brief: args.brief ? 1 : undefined,
    });
    const out = { type: type.key, result: shapeRow(data, { raw: args.raw, fields: args.fields }) };
    if (warnings.length) out.warnings = warnings;
    return this.out(out);
  }

  async tool_count_objects({ queries }) {
    this.needsNetBox();
    if (!Array.isArray(queries) || !queries.length) throw new ToolError("queries must be a non-empty array");
    if (queries.length > 50) throw new ToolError("at most 50 queries per call");
    const warnings = await this.versionWarnings();
    const counts = await Promise.all(queries.map(async (query) => {
      const row = { type: query.type };
      if (query.filters && Object.keys(query.filters).length) row.filters = query.filters;
      if (query.q) row.q = query.q;
      try {
        const type = this.type(query.type);
        row.type = type.key;
        const filters = this.filterQuery(type, query.filters, warnings);
        const { data } = await this.client.get(type.path, { ...filters, q: query.q, fields: "id", limit: 1 });
        row.count = data.count;
      } catch (error) {
        row.error = this.client.redact(error.message);
      }
      return row;
    }));
    const out = { counts };
    if (warnings.length) out.warnings = warnings;
    return this.out(out);
  }

  async tool_search_objects({ q, types, limit }) {
    this.needsNetBox();
    if (typeof q !== "string" || !q.trim()) throw new ToolError("q is required");
    const perType = Math.min(Math.max(1, limit ?? 5), 50);
    const resolved = (types?.length ? types : DEFAULT_SEARCH_TYPES).map((name) => this.type(name));
    const warnings = await this.versionWarnings();
    const hits = {};
    const errors = {};
    let total = 0;
    await Promise.all(resolved.map(async (type) => {
      try {
        const { data } = await this.client.get(type.path, { q, brief: 1, limit: perType });
        if (data.count) {
          total += data.count;
          hits[type.key] = { count: data.count, returned: data.results.length, results: data.results.map((row) => brief(row)) };
        }
      } catch (error) {
        errors[type.key] = this.client.redact(error.message);
      }
    }));
    const ordered = Object.fromEntries(resolved.filter((type) => hits[type.key]).map((type) => [type.key, hits[type.key]]));
    const out = { q, searched: resolved.length, types_with_hits: Object.keys(ordered).length, total_hits: total, hits: ordered };
    if (Object.keys(errors).length) out.errors = errors;
    if (warnings.length) out.warnings = warnings;
    return this.out(out);
  }

  async tool_get_changelog(args) {
    this.needsNetBox();
    const warnings = await this.versionWarnings();
    let objectType;
    if (args.object_type) {
      try {
        objectType = this.type(args.object_type).ct;
      } catch {
        objectType = args.object_type;
      }
    }
    const data = args.data ?? "none";
    const baseFields = "id,time,user_name,request_id,action,changed_object_type,changed_object_id,object_repr,message";
    const query = {
      changed_object_type: objectType,
      changed_object_id: args.object_id,
      user_name: args.user,
      request_id: args.request_id,
      action: args.action,
      time_after: args.since,
      time_before: args.until,
      q: args.q,
      ordering: "-time",
      limit: Math.min(Math.max(1, args.limit ?? 25), 1000),
      offset: args.offset ?? 0,
      fields: data === "none" ? baseFields : `${baseFields},prechange_data,postchange_data`,
    };
    const { data: page } = await this.client.get("/api/core/object-changes/", query);
    const results = page.results.map((change) => {
      const row = maybeShape({ ...change, prechange_data: undefined, postchange_data: undefined }, false);
      if (data === "full") {
        row.prechange_data = change.prechange_data;
        row.postchange_data = change.postchange_data;
      } else if (data === "diff") {
        row.diff = diff(change.prechange_data, change.postchange_data);
      }
      return row;
    });
    const envelope = { count: page.count, returned: results.length, offset: query.offset };
    if (query.offset + results.length < page.count) envelope.next_offset = query.offset + results.length;
    if (warnings.length) envelope.warnings = warnings;
    envelope.results = results;
    return capList(envelope, this.maxOutputBytes, { offset: query.offset });
  }

  allocation(args) {
    const type = this.type(args.type);
    const kinds = ALLOCATIONS[type.key];
    if (!kinds) throw new ToolError(`type must be one of ${Object.keys(ALLOCATIONS).join(", ")}`);
    const kind = args.kind ?? Object.keys(kinds)[0];
    const entry = kinds[kind];
    if (!entry) throw new ToolError(`${type.key} supports kind ${Object.keys(kinds).join(" or ")}`);
    if (!Number.isInteger(args.id)) throw new ToolError("id must be an integer");
    const [segment, target, assigned] = entry;
    return { type, kind, segment, target, assigned, path: `${type.path}${args.id}/${segment}/` };
  }

  async tool_get_available_resources(args) {
    this.needsNetBox();
    const { type, kind, path } = this.allocation(args);
    const warnings = await this.versionWarnings();
    const limit = Math.min(Math.max(1, args.limit ?? 50), 1000);
    const { data } = await this.client.get(path, { limit });
    const all = Array.isArray(data) ? data : data?.results ?? [];
    // available-ips honours limit; available-prefixes/vlans/asns return the
    // whole list, in which case its length is the true total.
    const complete = Array.isArray(data) && (kind !== "ips" || all.length > limit);
    const rows = all.slice(0, limit);
    const envelope = {
      type: type.key, id: args.id, kind,
      count: Array.isArray(data) ? (complete ? all.length : null) : data?.count ?? null,
      returned: rows.length,
    };
    if (envelope.count === null) envelope.note = "NetBox reports no total here; returned is capped by limit";
    if (warnings.length) envelope.warnings = warnings;
    envelope.results = rows.map((row) => maybeShape(row, false));
    return capList(envelope, this.maxOutputBytes);
  }

  async tool_trace_path(args) {
    this.needsNetBox();
    const type = this.type(args.type);
    const segment = ["trace", "paths"].find((name) => type.special?.[name]);
    if (!segment) {
      const capable = Object.entries(this.catalog.data.types).filter(([, t]) => t.special?.trace || t.special?.paths).map(([key]) => key);
      throw new ToolError(`${type.key} has no trace or paths endpoint; use one of ${capable.join(", ")}`);
    }
    if (!Number.isInteger(args.id)) throw new ToolError("id must be an integer");
    const warnings = await this.versionWarnings();
    const { data } = await this.client.get(`${type.path}${args.id}/${segment}/`);
    let result;
    if (args.raw) result = data;
    else if (segment === "trace" && Array.isArray(data)) {
      result = data.map((hop) => (Array.isArray(hop) && hop.length === 3
        ? { near: briefList(hop[0]), cable: hop[1] ? cableBrief(hop[1]) : null, far: briefList(hop[2]) }
        : deepBrief(hop)));
    } else {
      result = deepBrief(data);
    }
    const out = { type: type.key, id: args.id, endpoint: segment };
    if (Array.isArray(result)) out.segments = result.length;
    if (warnings.length) out.warnings = warnings;
    out.result = result;
    return this.out(out);
  }

  async tool_get_rack_elevation(args) {
    this.needsNetBox();
    if (!Number.isInteger(args.id)) throw new ToolError("id must be an integer");
    const warnings = await this.versionWarnings();
    const face = args.face ?? "front";
    const { data } = await this.client.get(`/api/dcim/racks/${args.id}/elevation/`, { face, limit: PAGE_MAX });
    const units = data.results ?? [];
    const rows = units
      .filter((unit) => args.include_empty || unit.device || unit.occupied)
      .map((unit) => {
        const row = { unit: unit.id, name: unit.name };
        if (unit.device) row.device = { id: unit.device.id, name: unit.device.name ?? unit.device.display };
        if (unit.occupied && !unit.device) row.occupied = true;
        return row;
      });
    const envelope = { rack_id: args.id, face, count: data.count, occupied: units.filter((u) => u.device || u.occupied).length, returned: rows.length };
    if (warnings.length) envelope.warnings = warnings;
    envelope.results = rows;
    return capList(envelope, this.maxOutputBytes);
  }

  async tool_graphql_query({ query, variables }) {
    this.needsNetBox();
    if (typeof query !== "string" || !query.trim()) throw new ToolError("query is required");
    if (isMutation(query)) throw new ToolError("graphql_query is read-only: mutations and subscriptions are refused");
    const { data } = await this.client.request("POST", "/graphql/", { body: { query, variables: variables ?? {} }, retry: true });
    if (data?.errors?.length && !data.data) {
      throw new ToolError(`GraphQL errors: ${data.errors.map((error) => error.message).join("; ").slice(0, 2000)}`);
    }
    return this.out(data);
  }

  async tool_get_rendered_config(args) {
    this.needsNetBox();
    const type = this.type(args.type);
    if (!type.special?.["render-config"]) throw new ToolError("type must be dcim.devices or virtualization.virtual-machines");
    if (!Number.isInteger(args.id)) throw new ToolError("id must be an integer");
    const { data, requestId } = await this.client.request("POST", `${type.path}${args.id}/render-config/`, { body: {}, retry: true });
    return this.out({ type: type.key, id: args.id, template: data?.configtemplate ? brief(data.configtemplate) : undefined, content: data?.content, request_id: requestId });
  }

  // ---- write tools ---------------------------------------------------------

  // Why this server refuses writes to a type, or undefined when it allows them.
  writeRefusal(type) {
    if (this.readOnly) return "NETBOX_READ_ONLY=1";
    const [app] = type.key.split(".");
    if ((ADMIN_APPS.has(app) || ADMIN_TYPES.has(type.key)) && !this.allowAdminWrites) {
      return `writes to ${type.key} are refused; set NETBOX_ALLOW_ADMIN_WRITES=1 to allow admin writes`;
    }
    return undefined;
  }

  writable(type, op) {
    if (!type.ops.includes(op)) throw new ToolError(`${type.key} does not support ${op} (ops: ${type.ops.join(" ")})`);
    const refusal = this.writeRefusal(type);
    if (refusal) throw new ToolError(refusal);
  }

  // Sends one write. An unknown outcome gets the type and action for get_changelog.
  async send(method, path, body, type, action) {
    try {
      return await this.client.request(method, path, { body });
    } catch (error) {
      if (error?.outcomeUnknown) throw new ToolError(`${error.message} Narrow it with object_type="${type.key}" action="${action}".`);
      throw error;
    }
  }

  validate(fields, data, options, warnings) {
    const errors = validatePayload(fields ?? {}, data, options);
    if (!errors.length) return;
    if (this.versionMismatch) warnings.push(...errors);
    else throw new ToolError(`validation failed: ${errors.join("; ")}`);
  }

  responseFields(type, fields, warnings) {
    if (fields === undefined) return undefined;
    if (!Array.isArray(fields) || fields.some((field) => typeof field !== "string")) throw new ToolError("fields must be an array of strings");
    const readable = new Set((type.read ?? "").split(" ").filter(Boolean));
    const unknown = readable.size ? fields.filter((field) => !readable.has(field)) : [];
    if (unknown.length) warnings.push(`fields not readable on ${type.key}: ${unknown.join(", ")}`);
    return fields;
  }

  writeResult({ type, method, path, body, dryRun, response, raw, fields, warnings, extra = {} }) {
    if (dryRun) {
      return this.out({ dry_run: true, valid: true, method, path, body, ...extra, ...(warnings.length ? { warnings } : {}) });
    }
    const results = Array.isArray(response.data) ? response.data : [response.data];
    const envelope = { type: type.key, method, request_id: response.requestId ?? null, count: results.length, returned: results.length, ...extra };
    if (warnings.length) envelope.warnings = warnings;
    envelope.results = results.map((row) => shapeRow(fields?.length ? project(row, fields) : row, { raw, fields }));
    return capList(envelope, this.maxOutputBytes);
  }

  async tool_create_objects({ type: name, data, dry_run: dryRun, fields, raw }) {
    const type = this.type(name);
    this.writable(type, "create");
    if (data === undefined || data === null || typeof data !== "object") throw new ToolError("data must be an object or array");
    if (Array.isArray(data) && data.length > BULK_MAX) throw new ToolError(`at most ${BULK_MAX} objects per call`);
    const warnings = dryRun ? [] : (this.needsNetBox(), await this.versionWarnings());
    this.validate(type.fields, data, { mode: "create" }, warnings);
    const projection = this.responseFields(type, fields, warnings);
    const response = dryRun ? undefined : await this.send("POST", type.path, data, type, "create");
    return this.writeResult({ type, method: "POST", path: type.path, body: data, dryRun, response, raw, fields: projection, warnings });
  }

  async tool_update_objects({ type: name, id, data, dry_run: dryRun, fields, raw }) {
    const type = this.type(name);
    if (data === undefined || data === null || typeof data !== "object") throw new ToolError("data must be an object or array");
    let path;
    let body;
    if (id !== undefined || (!Array.isArray(data) && Number.isInteger(data.id))) {
      if (Array.isArray(data)) throw new ToolError("with id, data must be one object");
      const target = id ?? data.id;
      if (!Number.isInteger(target)) throw new ToolError("id must be an integer");
      if (data.id !== undefined && data.id !== target) throw new ToolError("data.id does not match id");
      this.writable(type, "update");
      path = `${type.path}${target}/`;
      body = { ...data };
      delete body.id;
    } else {
      if (!Array.isArray(data)) throw new ToolError("give id, or data as an array of objects with id");
      if (data.length > BULK_MAX) throw new ToolError(`at most ${BULK_MAX} objects per call`);
      this.writable(type, "bulk_update");
      path = type.path;
      body = data;
    }
    if (!Array.isArray(body) && !Object.keys(body).length) throw new ToolError("data has no fields to change");
    const warnings = dryRun ? [] : (this.needsNetBox(), await this.versionWarnings());
    this.validate(type.fields, body, { mode: "update", bulk: Array.isArray(body) }, warnings);
    const projection = this.responseFields(type, fields, warnings);
    const response = dryRun ? undefined : await this.send("PATCH", path, body, type, "update");
    return this.writeResult({ type, method: "PATCH", path, body, dryRun, response, raw, fields: projection, warnings });
  }

  async tool_allocate_available(args) {
    const { type, kind, path, target, assigned } = this.allocation(args);
    const targetType = this.type(target);
    this.writable(targetType, "create");
    const data = args.data ?? {};
    if (typeof data !== "object" || data === null) throw new ToolError("data must be an object or array");
    if (Array.isArray(data) && (!data.length || data.length > BULK_MAX)) throw new ToolError(`data array needs 1-${BULK_MAX} objects`);
    const special = type.special?.[`available-${kind}`]?.f ?? {};
    const fields = { ...(targetType.fields ?? {}) };
    delete fields[assigned];
    for (const [field, spec] of Object.entries(special)) if (field !== assigned) fields[field] = { ...spec, r: undefined };
    const warnings = args.dry_run ? [] : (this.needsNetBox(), await this.versionWarnings());
    this.validate(fields, data, { mode: "update" }, warnings);
    const items = Array.isArray(data) ? data : [data];
    const required = kind === "prefixes" ? "prefix_length" : kind === "vlans" ? "name" : undefined;
    if (required && items.some((item) => item[required] === undefined)) throw new ToolError(`each allocation needs "${required}"`);
    const response = args.dry_run ? undefined : await this.send("POST", path, data, targetType, "create");
    return this.writeResult({ type: targetType, method: "POST", path, body: data, dryRun: args.dry_run, response, raw: args.raw, warnings, extra: { allocated_from: { type: type.key, id: args.id, kind } } });
  }

  async tool_delete_objects({ type: name, ids, confirm, dry_run: dryRun }) {
    const type = this.type(name);
    const list = Array.isArray(ids) ? ids : [ids];
    if (!list.length || list.some((value) => !Number.isInteger(value) || value < 1)) throw new ToolError("ids must be positive integers");
    if (new Set(list).size !== list.length) throw new ToolError("ids contains duplicates");
    if (list.length > DELETE_MAX) throw new ToolError(`at most ${DELETE_MAX} ids per call`);
    if (confirm !== list.length) throw new ToolError(`confirm must equal the number of ids (${list.length})`);
    this.writable(type, list.length === 1 ? "delete" : "bulk_delete");
    this.needsNetBox();
    const warnings = await this.versionWarnings();
    const { data: found } = await this.client.get(type.path, { id: list, brief: 1, limit: list.length });
    const existing = new Map(found.results.map((row) => [row.id, row]));
    const missing = list.filter((value) => !existing.has(value));
    if (missing.length) throw new ToolError(`nothing deleted: ${type.key} ids not found: ${missing.join(", ")}`);
    const objects = list.map((value) => brief(existing.get(value)));
    const single = list.length === 1;
    const path = single ? `${type.path}${list[0]}/` : type.path;
    const body = single ? undefined : list.map((value) => ({ id: value }));
    const batches = [];
    for (let index = 0; index < list.length; index += DELETE_BATCH) batches.push(list.slice(index, index + DELETE_BATCH));
    if (dryRun) {
      const batching = batches.length > 1 ? { batches: batches.length, note: `sent as ${batches.length} sequential requests of up to ${DELETE_BATCH} ids` } : {};
      const cascade = { cascade: cascadeNote(type.key) };
      const counts = await this.cascadeCounts(type.key, list);
      if (counts) cascade.cascade_counts = counts;
      return this.out({ dry_run: true, valid: true, method: "DELETE", path, body, ...batching, would_delete: objects, ...cascade, ...(warnings.length ? { warnings } : {}) });
    }
    const requestIds = [];
    const deleted = [];
    for (const batch of batches) {
      try {
        const response = await this.send("DELETE", path, single ? undefined : batch.map((value) => ({ id: value })), type, "delete");
        requestIds.push(response.requestId ?? null);
        deleted.push(...batch);
      } catch (error) {
        if (batches.length === 1) throw error;
        const pending = list.slice(deleted.length + batch.length);
        throw new ToolError(`partial delete of ${type.key}: ${deleted.length} of ${list.length} deleted (ids: ${deleted.join(", ") || "none"}; request ids: ${requestIds.join(", ") || "none"}). Batch ${requestIds.length + 1} of ${batches.length} failed (ids: ${batch.join(", ")}): ${error.message} Not attempted (ids: ${pending.join(", ") || "none"}).`);
      }
    }
    const out = { type: type.key, deleted: objects.length };
    if (requestIds.length === 1) out.request_id = requestIds[0];
    else out.request_ids = requestIds;
    out.objects = objects;
    out.cascade = cascadeNote(type.key);
    if (warnings.length) out.warnings = warnings;
    return this.out(out);
  }

  // Read-only counts of the main dependents, at most CASCADE_COUNT_MAX calls,
  // through the client's concurrency limit. A failed count never fails the dry run.
  async cascadeCounts(key, ids) {
    const rule = CASCADES[key];
    if (!rule) return undefined;
    return await Promise.all(rule.counts.slice(0, CASCADE_COUNT_MAX).map(async ([target, filter, effect]) => {
      const row = { type: target, filter, effect };
      try {
        const { data } = await this.client.get(this.type(target).path, { [filter]: ids, fields: "id", limit: 1 });
        row.count = data.count;
      } catch (error) {
        row.error = this.client.redact(error.message);
      }
      return row;
    }));
  }
}

export { ToolError };

function briefList(value) {
  return Array.isArray(value) ? value.map((item) => brief(item)) : value && typeof value === "object" ? [brief(value)] : [];
}

function cableBrief(cable) {
  const out = brief(cable);
  if (cable.label) out.label = cable.label;
  const status = cable.status?.value ?? cable.status;
  if (status) out.status = status;
  return out;
}

function deepBrief(value, depth = 0) {
  if (Array.isArray(value)) return value.map((item) => deepBrief(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  if (depth > 0 && value.id !== undefined && (value.url || value.display)) return brief(value);
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "url" || key === "display_url" || child === null) continue;
    out[key] = deepBrief(child, depth + 1);
  }
  return out;
}

export function diff(before, after) {
  const blank = (value) => !value || (typeof value === "object" && !Object.keys(value).length);
  if (blank(before)) return blank(after) ? {} : { after: shape(after) ?? {} };
  if (blank(after)) return { before: shape(before) ?? {} };
  const changes = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (["last_updated", "created"].includes(key)) continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes[key] = [before[key] ?? null, after[key] ?? null];
  }
  return changes;
}

// Strips comments and string literals, then looks for an operation keyword.
export function isMutation(query) {
  const stripped = query
    .replace(/"""[\s\S]*?"""/g, "\"\"")
    .replace(/"(?:\\.|[^"\\])*"/g, "\"\"")
    .replace(/#[^\n]*/g, "");
  return /(^|[\s{}])(mutation|subscription)\b/i.test(stripped);
}

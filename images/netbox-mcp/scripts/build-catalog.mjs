#!/usr/bin/env node
// Builds catalog.json from a NetBox OpenAPI schema. Runs on the host, never in
// the image. Usage:
//   node scripts/build-catalog.mjs --schema schema.json [--out catalog.json]
//   NETBOX_URL=https://netbox.example NETBOX_TOKEN=... node scripts/build-catalog.mjs --live
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE_PARAMS = new Set(["limit", "offset", "ordering", "q", "start", "brief", "fields", "omit", "exclude"]);
const STRING_LOOKUPS = "empty ic ie iew iregex isw n nic nie niew nisw regex";
const NUMBER_LOOKUPS = "empty gt gte lt lte n";
// Short codes for the two lookup sets that cover most filters.
const LOOKUP_CODES = { [STRING_LOOKUPS]: "s", [NUMBER_LOOKUPS]: "#" };
const SPECIAL_SEGMENTS = new Set([
  "available-ips", "available-prefixes", "available-vlans", "available-asns",
  "trace", "paths", "elevation", "render-config", "render", "sync", "choices",
]);

const refName = (ref) => ref?.split("/").pop();

function resolveRef(schema, ref) {
  return schema.components.schemas[refName(ref)];
}

function jsonBodySchema(operation) {
  const body = operation?.requestBody?.content?.["application/json"]?.schema;
  if (!body) return undefined;
  if (body.$ref) return refName(body.$ref);
  for (const option of body.oneOf ?? []) if (option.$ref) return refName(option.$ref);
  if (body.items?.$ref) return refName(body.items.$ref);
  return undefined;
}

function modelName(schemaName) {
  return schemaName?.replace(/WithConfigContext$/, "");
}

function findRef(node) {
  if (!node || typeof node !== "object") return undefined;
  if (node.$ref) return refName(node.$ref);
  for (const option of [...(node.oneOf ?? []), ...(node.allOf ?? []), ...(node.anyOf ?? [])]) {
    const found = findRef(option);
    if (found) return found;
  }
  return undefined;
}

function targetFor(requestSchemaName, modelIndex) {
  const base = requestSchemaName?.replace(/^(Brief|Nested)/, "").replace(/Request$/, "");
  return modelIndex.get(base) ?? modelIndex.get(`${base}WithConfigContext`);
}

// One compact descriptor per writable field: { t, r?, n?, e?, ref?, d? }.
export function describeField(property, required, modelIndex) {
  const out = {};
  const nullable = Boolean(property.nullable || property.oneOf?.some((o) => o.nullable) || property.enum?.includes(null));
  if (Array.isArray(property.enum)) {
    out.t = property.type ?? "string";
    out.e = property.enum.filter((value) => value !== null && value !== "");
  } else if (property.type === "array") {
    const itemRef = findRef(property.items);
    const target = itemRef && targetFor(itemRef, modelIndex);
    if (target) {
      out.t = "ref[]";
      out.ref = target;
    } else if (property.items?.enum) {
      out.t = "enum[]";
      out.e = property.items.enum.filter((value) => value !== null && value !== "");
    } else {
      out.t = `${property.items?.type ?? (itemRef ? "object" : "any")}[]`;
    }
  } else if (property.oneOf || property.allOf || property.$ref) {
    const ref = findRef(property);
    const target = ref && targetFor(ref, modelIndex);
    if (target) {
      out.t = "ref";
      out.ref = target;
    } else {
      out.t = property.oneOf?.find((o) => o.type)?.type ?? "object";
    }
  } else {
    out.t = property.type ?? "any";
  }
  if (property.format === "date-time" || property.format === "date") out.t = property.format;
  if (required) out.r = 1;
  if (nullable && !required) out.n = 1;
  if (property.default !== undefined && property.default !== null && typeof property.default !== "object") out.d = property.default;
  return out;
}

function fieldsFor(schema, schemaName, modelIndex) {
  const component = schema.components.schemas[schemaName];
  if (!component) return {};
  const required = new Set(component.required ?? []);
  const fields = {};
  for (const [name, property] of Object.entries(component.properties ?? {})) {
    if (property.readOnly) continue;
    fields[name] = describeField(property, required.has(name), modelIndex);
  }
  return fields;
}

// "name:s id:# tag:n slug" - base filter names with their lookup suffixes.
export function compactFilters(parameters = []) {
  const bases = new Map();
  for (const parameter of parameters) {
    if (parameter.in !== "query" || BASE_PARAMS.has(parameter.name)) continue;
    const [base, suffix] = parameter.name.split("__");
    if (!bases.has(base)) bases.set(base, []);
    if (suffix) bases.get(base).push(suffix);
  }
  return [...bases.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([base, suffixes]) => {
      if (!suffixes.length) return base;
      const key = [...suffixes].sort().join(" ");
      return `${base}:${LOOKUP_CODES[key] ?? [...suffixes].sort().join(",")}`;
    })
    .join(" ");
}

export function buildCatalog(schema, { source = "schema" } = {}) {
  const version = String(schema.info?.version ?? "").match(/^\d+\.\d+\.\d+/)?.[0] ?? "unknown";
  const collections = Object.keys(schema.paths).filter((path) => /^\/api\/[a-z0-9-]+\/[a-z0-9-]+\/$/.test(path));
  const modelIndex = new Map();
  const list = [];
  for (const path of collections) {
    const get = schema.paths[path].get;
    const ref = get?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref;
    if (!ref?.includes("Paginated")) continue;
    const paginated = resolveRef(schema, ref);
    const model = refName(paginated?.properties?.results?.items?.$ref);
    if (!model) continue;
    const [, , app, resource] = path.split("/");
    const key = `${app}.${resource}`;
    modelIndex.set(model, key);
    list.push({ key, app, resource, path, model });
  }

  const types = {};
  for (const { key, app, path, model } of list) {
    const collection = schema.paths[path];
    const detail = schema.paths[`${path}{id}/`] ?? {};
    const ops = [];
    if (collection.get) ops.push("list");
    if (detail.get) ops.push("get");
    if (collection.post) ops.push("create");
    if (detail.patch) ops.push("update");
    if (detail.delete) ops.push("delete");
    if (collection.patch) ops.push("bulk_update");
    if (collection.delete) ops.push("bulk_delete");
    const writeSchema = jsonBodySchema(collection.post) ?? jsonBodySchema(detail.patch);
    const response = schema.components.schemas[model];
    const special = {};
    for (const candidate of Object.keys(schema.paths)) {
      if (!candidate.startsWith(`${path}{id}/`) || candidate === `${path}{id}/`) continue;
      const segment = candidate.slice(`${path}{id}/`.length).replace(/\/$/, "");
      if (!SPECIAL_SEGMENTS.has(segment)) continue;
      const methods = Object.keys(schema.paths[candidate]).filter((m) => ["get", "post"].includes(m)).map((m) => m.toUpperCase());
      const entry = { m: methods };
      const body = jsonBodySchema(schema.paths[candidate].post);
      if (body && segment.startsWith("available-")) entry.f = fieldsFor(schema, body, modelIndex);
      special[segment] = entry;
    }
    const type = {
      ct: `${app}.${modelName(model).toLowerCase()}`,
      model: modelName(model),
      path,
      ops,
      filters: compactFilters(collection.get?.parameters),
      read: Object.keys(response?.properties ?? {}).join(" "),
    };
    if (writeSchema) type.fields = fieldsFor(schema, writeSchema, modelIndex);
    if (Object.keys(special).length) type.special = special;
    types[key] = type;
  }
  return {
    netbox_version: version,
    schema_version: schema.info?.version ?? null,
    openapi: schema.openapi ?? null,
    source,
    lookups: { s: STRING_LOOKUPS, "#": NUMBER_LOOKUPS },
    types,
  };
}

async function loadLiveSchema() {
  const base = process.env.NETBOX_URL?.replace(/\/+$/, "").replace(/\/api$/, "");
  if (!base) throw new Error("NETBOX_URL is required with --live");
  const token = process.env.NETBOX_TOKEN ?? (process.env.NETBOX_TOKEN_FILE && readFileSync(process.env.NETBOX_TOKEN_FILE, "utf8").trim());
  if (!token) throw new Error("NETBOX_TOKEN or NETBOX_TOKEN_FILE is required with --live");
  const response = await fetch(`${base}/api/schema/?format=json`, {
    headers: { Accept: "application/json", Authorization: token.startsWith("nbt_") ? `Bearer ${token}` : `Token ${token}` },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`schema download failed with HTTP ${response.status}`);
  return await response.json();
}

async function main(argv) {
  const here = dirname(fileURLToPath(import.meta.url));
  let schemaPath;
  let live = false;
  let out = resolve(here, "..", "catalog.json");
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--schema") schemaPath = argv[++i];
    else if (argv[i] === "--out") out = argv[++i];
    else if (argv[i] === "--live") live = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!live && !schemaPath) throw new Error("pass --schema <file> or --live");
  const schema = live ? await loadLiveSchema() : JSON.parse(readFileSync(schemaPath, "utf8"));
  const catalog = buildCatalog(schema, { source: live ? "live" : "file" });
  const text = `${JSON.stringify(catalog)}\n`;
  writeFileSync(out, text);
  process.stdout.write(`wrote ${out}: ${Object.keys(catalog.types).length} types, ${Buffer.byteLength(text)} bytes, NetBox ${catalog.netbox_version}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`build-catalog: ${error.message}\n`);
    process.exit(1);
  });
}

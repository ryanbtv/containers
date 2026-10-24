// Loads catalog.json once and validates write payloads against it.
import { readFileSync } from "node:fs";

let cached;

export function loadCatalog(path) {
  if (!cached || cached.path !== path) {
    const data = JSON.parse(readFileSync(path, "utf8"));
    cached = { path, data, index: buildIndex(data) };
  }
  return cached;
}

export function resetCatalogCache() {
  cached = undefined;
}

function buildIndex(data) {
  const aliases = new Map();
  const ambiguous = new Set();
  const add = (alias, key) => {
    if (aliases.has(alias) && aliases.get(alias) !== key) ambiguous.add(alias);
    else aliases.set(alias, key);
  };
  for (const [key, type] of Object.entries(data.types)) {
    const [app, resource] = key.split(".");
    add(key, key);
    add(`${app}/${resource}`, key);
    add(type.ct, key);
    add(resource, key);
    add(resource.replace(/-/g, "_"), key);
    add(`${app}.${resource.replace(/-/g, "_")}`, key);
  }
  for (const alias of ambiguous) if (!data.types[alias]) aliases.delete(alias);
  return { aliases, ambiguous };
}

export class CatalogError extends Error {}

export function resolveType(catalog, input) {
  if (typeof input !== "string" || !input.trim()) throw new CatalogError("type is required, e.g. \"dcim.devices\"");
  const cleaned = input.trim().toLowerCase().replace(/^\/?api\//, "").replace(/\/+$/, "").replace(/^\//, "");
  const key = catalog.index.aliases.get(cleaned);
  if (key) return { key, ...catalog.data.types[key] };
  if (catalog.index.ambiguous.has(cleaned)) {
    const matches = Object.keys(catalog.data.types).filter((name) => name.endsWith(`.${cleaned}`) || name.endsWith(`.${cleaned.replace(/_/g, "-")}`));
    throw new CatalogError(`type "${input}" is ambiguous; use one of: ${matches.join(", ")}`);
  }
  const needle = cleaned.split(/[./]/).pop().replace(/_/g, "-").replace(/s$/, "");
  const suggestions = Object.keys(catalog.data.types).filter((name) => name.includes(needle)).slice(0, 8);
  throw new CatalogError(`unknown type "${input}"${suggestions.length ? `; did you mean: ${suggestions.join(", ")}` : "; call list_object_types"}`);
}

export function parseFilters(compact) {
  const map = new Map();
  for (const token of (compact ?? "").split(" ").filter(Boolean)) {
    const [base, code] = token.split(":");
    map.set(base, code ?? "");
  }
  return map;
}

export function suffixesFor(catalog, code) {
  if (!code) return [];
  return (catalog.data.lookups?.[code] ?? code.replace(/,/g, " ")).split(" ").filter(Boolean);
}

const LOOKUP_TEXT = {
  n: "not equal", ic: "contains", nic: "does not contain", ie: "equals, any case", nie: "not equal, any case",
  isw: "starts with", nisw: "does not start with", iew: "ends with", niew: "does not end with",
  regex: "regex", iregex: "regex, any case", empty: "is empty, true or false",
  gt: ">", gte: ">=", lt: "<", lte: "<=", after: "after", before: "before",
};

// Django lookup names that NetBox spells differently or does not expose.
const DJANGO_LOOKUPS = {
  exact: (base) => `use ${base}=<value> for an exact match`,
  iexact: (base) => `use ${base}__ie`,
  contains: (base) => `use ${base}__ic`,
  icontains: (base) => `use ${base}__ic`,
  startswith: (base) => `use ${base}__isw`,
  istartswith: (base) => `use ${base}__isw`,
  endswith: (base) => `use ${base}__iew`,
  iendswith: (base) => `use ${base}__iew`,
  in: (base) => `pass an array to ${base}; values are ORed`,
  isnull: (base, suffixes) => (suffixes.includes("empty")
    ? `use ${base}__empty=true or false`
    : `to match an unset value, pass {"${base}": null}, sent as ${base}=null`),
};

function lookupList(base, suffixes) {
  if (!suffixes.length) return `"${base}" takes no lookups; use ${base}=<value>`;
  return `Supported: ${suffixes.map((suffix) => `${base}__${suffix} (${LOOKUP_TEXT[suffix] ?? suffix})`).join(", ")}`;
}

function hopHint(base, rest, known) {
  const target = rest.at(-1);
  const parts = ["Multi-hop (related-field) filters are not supported by the NetBox REST API"];
  const isRelation = (name) => name.endsWith("_id") || known.has(`${name}_id`);
  if (rest.length === 1 && known.has(`${base}_${target}`)) parts.push(`This type has a "${base}_${target}" filter; try that`);
  else if (target !== base && known.has(target) && isRelation(target)) parts.push(`This type has its own "${target}" filter; try that`);
  else if (rest.length === 1 && ["name", "slug"].includes(target)) parts.push(`"${base}" itself usually matches the related object's name or slug`);
  const ref = known.has(`${base}_id`) ? `${base}_id=<id>` : `${base}=<value>`;
  parts.push(`Otherwise resolve the related object first and filter with ${ref}, or use graphql_query for a multi-hop read`);
  return parts;
}

export function checkFilters(catalog, type, filters) {
  const errors = [];
  const known = parseFilters(type.filters);
  const allLookups = new Set(Object.keys(LOOKUP_TEXT));
  for (const name of Object.keys(filters ?? {})) {
    if (["limit", "offset", "start", "fields", "brief", "omit", "exclude", "ordering", "q"].includes(name)) {
      errors.push(`"${name}" is a tool argument, not a filter`);
      continue;
    }
    const [base, ...rest] = name.split("__");
    const suffix = rest[0];
    if (!known.has(base)) {
      errors.push(`unknown filter "${name}"${hint(base, [...known.keys()])}`);
      continue;
    }
    if (suffix === undefined) continue;
    const suffixes = suffixesFor(catalog, known.get(base));
    if (rest.length === 1 && suffixes.includes(suffix)) continue;
    const parts = [`filter "${base}" has no "__${rest.join("__")}" lookup`];
    const relation = base.endsWith("_id") || known.has(`${base}_id`) || Boolean(type.fields?.[base]?.ref);
    if (rest.length === 1 && DJANGO_LOOKUPS[suffix]) parts[0] += ` (${DJANGO_LOOKUPS[suffix](base, suffixes)})`;
    else if (rest.length > 1 || (relation && !allLookups.has(suffix))) parts.push(...hopHint(base, rest, known));
    parts.push(lookupList(base, suffixes));
    errors.push(parts.join(". "));
  }
  return errors;
}

function hint(name, candidates) {
  const close = candidates.filter((candidate) => candidate.includes(name) || name.includes(candidate)).slice(0, 6);
  return close.length ? `; similar: ${close.join(", ")}` : "";
}

export const ENUM_LIMIT = 40;
const ENUM_SHOWN = 25;

export function describeFieldText(field, { fullEnums = true } = {}) {
  let text = field.t;
  if (field.ref) text += ` ${field.ref}`;
  if (field.e) {
    text += fullEnums || field.e.length <= ENUM_LIMIT
      ? ` [${field.e.join("|")}]`
      : ` [${field.e.slice(0, ENUM_SHOWN).join("|")}|…] (${field.e.length} values, first ${ENUM_SHOWN} shown; full_enums=true lists all)`;
  }
  if (field.r) text += " required";
  if (field.n) text += " nullable";
  if (field.d !== undefined) text += ` default=${field.d}`;
  return text;
}

function typeOk(field, value) {
  if (value === null) return Boolean(field.n) || field.t === "any";
  switch (field.t) {
    case "integer": return Number.isInteger(value);
    case "number": return typeof value === "number" || (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value)));
    case "boolean": return typeof value === "boolean";
    case "string": case "date": case "date-time": return typeof value === "string";
    case "ref": return Number.isInteger(value) || (value && typeof value === "object" && !Array.isArray(value));
    case "object": return value && typeof value === "object" && !Array.isArray(value);
    case "any": return true;
    default:
      if (field.t.endsWith("[]")) return Array.isArray(value);
      return true;
  }
}

/**
 * Validates one object. mode: "create" enforces required fields; "update"
 * requires nothing except an integer id when bulk is true.
 */
export function validateObject(fields, object, { mode, bulk = false, extraAllowed = [], index } = {}) {
  const errors = [];
  const where = index === undefined ? "" : `[${index}] `;
  if (!object || typeof object !== "object" || Array.isArray(object)) return [`${where}must be an object`];
  for (const [name, value] of Object.entries(object)) {
    if (name === "id") {
      if (mode === "create") errors.push(`${where}"id" is not allowed on create`);
      else if (!Number.isInteger(value)) errors.push(`${where}"id" must be an integer`);
      continue;
    }
    if (extraAllowed.includes(name)) continue;
    const field = fields[name];
    if (!field) {
      errors.push(`${where}unknown field "${name}"${hint(name, Object.keys(fields))}`);
      continue;
    }
    if (!typeOk(field, value)) {
      errors.push(`${where}"${name}" expects ${describeFieldText(field)}, got ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`);
      continue;
    }
    if (field.e && value !== null && value !== "") {
      const values = field.t === "enum[]" ? value : [value];
      for (const item of values) {
        if (!field.e.includes(item)) errors.push(`${where}"${name}" value ${JSON.stringify(item)} is not one of ${field.e.join("|")}`);
      }
    }
  }
  if (mode === "create") {
    for (const [name, field] of Object.entries(fields)) {
      if (field.r && field.d === undefined && !(name in object)) errors.push(`${where}missing required field "${name}"`);
    }
  }
  if (mode === "update" && bulk && !Number.isInteger(object.id)) errors.push(`${where}bulk update items need an integer "id"`);
  return errors;
}

export function validatePayload(fields, data, options) {
  const items = Array.isArray(data) ? data : [data];
  if (Array.isArray(data) && data.length === 0) return ["data must not be empty"];
  return items.flatMap((item, index) => validateObject(fields, item, { ...options, index: Array.isArray(data) ? index : undefined }));
}

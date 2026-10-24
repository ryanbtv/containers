// Token-efficient output shaping and size capping.
const DROP_KEYS = new Set(["url", "display_url"]);

function isChoice(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && keys.includes("value") && keys.includes("label");
}

/**
 * Removes url/display_url, null, "", empty tags/custom_fields, and collapses
 * NetBox choice objects {value,label} to their value. Returns undefined for
 * values that should be dropped entirely. Custom-field keys keep null values,
 * so a reader can tell an unset custom field from one the type lacks.
 */
export function shape(value, depth = 0) {
  if (value === null || value === "") return undefined;
  if (Array.isArray(value)) return value.map((item) => shape(item, depth + 1) ?? null);
  if (typeof value !== "object") return value;
  if (isChoice(value)) return value.value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (DROP_KEYS.has(key)) continue;
    const shaped = key === "custom_fields" && isPlainObject(child)
      ? Object.fromEntries(Object.entries(child).map(([name, item]) => [name, shape(item, depth + 2) ?? null]))
      : shape(child, depth + 1);
    if (shaped === undefined) continue;
    if ((key === "tags" || key === "custom_fields") && isEmpty(shaped)) continue;
    out[key] = shaped;
  }
  return out;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isEmpty(value) {
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

export function maybeShape(value, raw) {
  return raw ? value : shape(value) ?? null;
}

// A nested NetBox reference: an object with a numeric id plus url or display.
function isRelated(value) {
  return isPlainObject(value) && typeof value.id === "number" && ("url" in value || "display" in value);
}

function related(object) {
  const out = { id: object.id };
  if (object.display !== undefined) out.display = object.display;
  if (object.name !== undefined && object.name !== object.display) out.name = object.name;
  if (object.slug !== undefined) out.slug = object.slug;
  return out;
}

/** Reduces each top-level related object (or list of them) to id, display, name, and slug. */
export function briefRelated(row) {
  if (!isPlainObject(row)) return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (isRelated(value)) out[key] = related(value);
    else if (Array.isArray(value)) out[key] = value.map((item) => (isRelated(item) ? related(item) : item));
    else out[key] = value;
  }
  return out;
}

/** Keeps id plus the named top-level fields. */
export function project(row, fields) {
  if (!isPlainObject(row)) return row;
  const out = {};
  for (const key of ["id", ...fields]) if (key in row) out[key] = row[key];
  return out;
}

/**
 * Output for a read or write row. With fields (and not raw), related
 * objects come back brief. raw keeps NetBox's JSON.
 */
export function shapeRow(row, { raw = false, fields } = {}) {
  if (raw) return row;
  return shape(fields?.length ? briefRelated(row) : row) ?? null;
}

/**
 * Serialises a list envelope, dropping trailing rows until it fits maxBytes.
 * envelope.results must be an array. Adds a truncation notice with the next
 * offset (or start cursor) needed to continue.
 */
export function capList(envelope, maxBytes, { offset = 0, cursor = false } = {}) {
  let text = JSON.stringify(envelope);
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const rows = envelope.results;
  let low = 0;
  let high = rows.length;
  let best = 0;
  const build = (n) => {
    const kept = rows.slice(0, n);
    const notice = {
      reason: `output exceeded ${maxBytes} bytes`,
      rows_omitted: rows.length - n,
    };
    if (cursor) notice.next_start = kept.length ? Number(kept.at(-1)?.id ?? 0) + 1 : undefined;
    else notice.next_offset = offset + n;
    notice.hint = "narrow with fields=, filters, or a smaller limit; or continue from next_offset/next_start";
    return { ...envelope, returned: n, results: kept, truncated: notice };
  };
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(build(mid))) <= maxBytes) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  text = JSON.stringify(build(best));
  return text;
}

export function capText(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const buffer = Buffer.from(text).subarray(0, maxBytes - 200);
  return `${buffer.toString("utf8").replace(/\uFFFD+$/, "")}\n…[truncated: output exceeded ${maxBytes} bytes; narrow the request]`;
}

// Reduces any NetBox object to a short reference.
export function brief(object) {
  if (!object || typeof object !== "object") return object;
  const out = { id: object.id };
  for (const key of ["display", "name", "address", "prefix", "vid", "asn"]) {
    if (object[key] !== undefined && object[key] !== null && object[key] !== "") {
      out[key] = isChoice(object[key]) ? object[key].value : object[key];
      if (key === "display") break;
    }
  }
  if (object.device?.name ?? object.device?.display) out.device = object.device.name ?? object.device.display;
  if (object.virtual_machine?.name) out.virtual_machine = object.virtual_machine.name;
  if (object.circuit?.cid) out.circuit = object.circuit.cid;
  if (object.object_type) out.object_type = object.object_type;
  return out;
}

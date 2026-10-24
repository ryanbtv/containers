// In-memory fake NetBox for tests. Not a test file itself.
import { createServer } from "node:http";

export async function startFakeNetBox({ version = "4.6.0", delayMs = 0 } = {}) {
  const state = {
    version,
    delayMs,
    requests: [],
    inflight: 0,
    maxInflight: 0,
    routes: new Map(),
    store: new Map(),
    nextId: 1000,
  };

  const collection = (path) => {
    if (!state.store.has(path)) state.store.set(path, []);
    return state.store.get(path);
  };

  const server = createServer(async (request, response) => {
    state.inflight += 1;
    state.maxInflight = Math.max(state.maxInflight, state.inflight);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url, "http://fake");
    const entry = { method: request.method, path: url.pathname, query: url.searchParams, headers: request.headers, body: raw ? JSON.parse(raw) : undefined };
    state.requests.push(entry);
    const send = (status, body, headers = {}) => {
      response.writeHead(status, { "Content-Type": "application/json", "X-Request-ID": "req-123", ...headers });
      response.end(body === undefined ? undefined : JSON.stringify(body));
      state.inflight -= 1;
    };
    if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    const custom = state.routes.get(`${request.method} ${url.pathname}`);
    if (custom) {
      const result = await custom(entry);
      return send(result.status ?? 200, result.body, result.headers);
    }
    if (url.pathname === "/api/status/") return send(200, { "netbox-version": state.version });
    const match = /^(\/api\/[a-z-]+\/[a-z-]+\/)(?:(\d+)\/)?$/.exec(url.pathname);
    if (!match) return send(404, { detail: "Not found." });
    const [, path, id] = match;
    const rows = collection(path);
    if (request.method === "GET" && !id) {
      let filtered = rows;
      const ids = url.searchParams.getAll("id").map(Number);
      if (ids.length) filtered = filtered.filter((row) => ids.includes(row.id));
      const q = url.searchParams.get("q");
      if (q) filtered = filtered.filter((row) => JSON.stringify(row).includes(q));
      const start = url.searchParams.get("start");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      if (start !== null) {
        const page = filtered.filter((row) => row.id >= Number(start)).sort((a, b) => a.id - b.id).slice(0, limit);
        return send(200, { count: null, next: page.length === limit ? "more" : null, previous: null, results: page });
      }
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const page = filtered.slice(offset, offset + limit);
      return send(200, { count: filtered.length, next: offset + limit < filtered.length ? "more" : null, previous: null, results: page });
    }
    if (request.method === "GET" && id) {
      const row = rows.find((item) => item.id === Number(id));
      return row ? send(200, row) : send(404, { detail: "No Device matches the given query." });
    }
    if (request.method === "POST" && !id) {
      const items = Array.isArray(entry.body) ? entry.body : [entry.body];
      const created = items.map((item) => ({ id: state.nextId++, url: `http://fake${path}x/`, ...item, tags: [], custom_fields: {} }));
      rows.push(...created);
      return send(201, Array.isArray(entry.body) ? created : created[0]);
    }
    if (request.method === "PATCH") {
      const items = id ? [{ ...entry.body, id: Number(id) }] : entry.body;
      const updated = items.map((item) => {
        const row = rows.find((candidate) => candidate.id === item.id);
        Object.assign(row, item);
        return row;
      });
      return send(200, id ? updated[0] : updated);
    }
    if (request.method === "DELETE") {
      const targets = id ? [Number(id)] : entry.body.map((item) => item.id);
      state.store.set(path, rows.filter((row) => !targets.includes(row.id)));
      return send(204);
    }
    return send(405, { detail: "Method not allowed." });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    state,
    seed(path, rows) {
      state.store.set(path, rows);
    },
    route(method, path, handler) {
      state.routes.set(`${method} ${path}`, handler);
    },
    reset() {
      state.requests.length = 0;
      state.maxInflight = 0;
      state.routes.clear();
    },
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

export const TOKEN = "nbt_testsecret0123456789abcdef";

export function devices(count, startId = 1) {
  return Array.from({ length: count }, (_, index) => ({
    id: startId + index,
    url: `http://fake/api/dcim/devices/${startId + index}/`,
    display_url: "x",
    display: `dev${startId + index}`,
    name: `dev${startId + index}`,
    status: { value: "active", label: "Active" },
    serial: "",
    rack: null,
    tags: [],
    custom_fields: {},
  }));
}

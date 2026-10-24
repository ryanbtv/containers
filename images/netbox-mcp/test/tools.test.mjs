import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { checkFilters, loadCatalog, resolveType } from "../src/catalog.mjs";
import { NetBoxClient } from "../src/netbox.mjs";
import { CASCADES, isMutation, listTools, TOOL_DEFS, Tools } from "../src/tools.mjs";
import { devices, startFakeNetBox, TOKEN } from "./fake-netbox.mjs";

const catalogPath = join(dirname(fileURLToPath(import.meta.url)), "..", "catalog.json");

describe("tools against a fake NetBox", () => {
  let fake;
  let tools;
  const make = (options = {}) => new Tools({
    client: new NetBoxClient({ url: fake.url, token: TOKEN, retryBaseMs: 1, retryMaxMs: 5 }),
    catalogPath,
    ...options,
  });
  const call = async (name, args, instance = tools) => JSON.parse(await instance.call(name, args));

  before(async () => {
    fake = await startFakeNetBox();
  });
  after(async () => {
    await fake.close();
  });
  beforeEach(() => {
    fake.reset();
    fake.state.version = "4.6.0";
    fake.seed("/api/dcim/devices/", devices(2600));
    fake.seed("/api/extras/tags/", [{ id: 7, url: "u", display: "mcp-test-tag", name: "mcp-test-tag", slug: "mcp-test-tag" }]);
    tools = make();
  });

  it("classifies every tool by name and hides writes in read-only mode", () => {
    const classes = Object.fromEntries(TOOL_DEFS.map((tool) => [tool.name, tool.class]));
    for (const [name, kind] of Object.entries(classes)) {
      if (kind === "read") assert.match(name, /^(list|describe|get|count|search|trace|graphql)_/);
      if (kind === "write") assert.match(name, /^(create|update|allocate)_/);
      if (kind === "dangerous") assert.match(name, /^delete_/);
    }
    const readOnly = listTools({ readOnly: true }).map((tool) => tool.name);
    assert.ok(readOnly.includes("get_objects"));
    assert.equal(readOnly.some((name) => /^(create|update|allocate|delete)_/.test(name)), false);
    assert.equal(listTools().length, TOOL_DEFS.length);
  });

  it("refuses write calls in read-only mode", async () => {
    await assert.rejects(make({ readOnly: true }).call("create_objects", { type: "extras.tags", data: {}, dry_run: true }), /NETBOX_READ_ONLY/);
  });

  it("paginates past 1000 rows with offset pages and reports count", async () => {
    const out = await call("get_objects", { type: "dcim.devices", limit: 2500, fields: ["id", "name"] }, make({ maxOutputBytes: 10_000_000 }));
    assert.equal(out.count, 2600);
    assert.equal(out.returned, 2500);
    assert.equal(out.results.length, 2500);
    assert.equal(out.results[2499].id, 2500);
    assert.equal(out.next_offset, 2500);
    const pages = fake.state.requests.filter((r) => r.path === "/api/dcim/devices/");
    assert.deepEqual(pages.map((r) => [r.query.get("offset"), r.query.get("limit")]), [["0", "1000"], ["1000", "1000"], ["2000", "500"]]);
    assert.equal(pages[0].query.get("fields"), "id,name");
  });

  it("stops at count when limit exceeds the rows available", async () => {
    const out = await call("get_objects", { type: "dcim.devices", limit: 5000, offset: 2500, brief: true });
    assert.equal(out.count, 2600);
    assert.equal(out.returned, 100);
    assert.equal(out.next_offset, undefined);
  });

  it("supports cursor paging with start and still returns count", async () => {
    const out = await call("get_objects", { type: "dcim.devices", start: 2590, limit: 5 });
    assert.equal(out.count, 2600);
    assert.deepEqual(out.results.map((r) => r.id), [2590, 2591, 2592, 2593, 2594]);
    assert.equal(out.next_start, 2595);
  });

  it("shapes rows unless raw is set, and passes query options through", async () => {
    const shaped = await call("get_objects", { type: "dcim.devices", limit: 1, filters: { status: ["active", "planned"], name__ic: "dev" }, ordering: "-name", omit: ["comments"] });
    assert.deepEqual(shaped.results[0], { id: 1, display: "dev1", name: "dev1", status: "active" });
    const request = fake.state.requests.at(-1);
    assert.deepEqual(request.query.getAll("status"), ["active", "planned"]);
    assert.equal(request.query.get("ordering"), "-name");
    assert.equal(request.query.get("omit"), "comments");
    const raw = await call("get_objects", { type: "dcim.devices", limit: 1, raw: true });
    assert.equal(raw.results[0].url, "http://fake/api/dcim/devices/1/");
  });

  it("truncates large output with a continuation offset", async () => {
    const out = await call("get_objects", { type: "dcim.devices", limit: 1000 }, make({ maxOutputBytes: 8_000 }));
    assert.equal(out.count, 2600);
    assert.ok(out.returned < 1000);
    assert.equal(out.truncated.next_offset, out.returned);
  });

  it("rejects unknown filters before calling NetBox", async () => {
    await assert.rejects(tools.call("get_objects", { type: "dcim.devices", filters: { bogus: 1 } }), /unknown filter "bogus"/);
    assert.equal(fake.state.requests.filter((r) => r.path === "/api/dcim/devices/").length, 0);
  });

  it("warns instead of failing when the live version differs from the catalog", async () => {
    fake.state.version = "4.7.1";
    const out = await call("get_objects", { type: "dcim.devices", limit: 1, filters: { new_filter: 1 } });
    assert.match(out.warnings.join(" "), /catalog was built from NetBox 4\.6\.0, server runs 4\.7\.1/);
    assert.match(out.warnings.join(" "), /unknown filter "new_filter"/);
  });

  it("counts several queries in one call with limit=1", async () => {
    const out = await call("count_objects", { queries: [{ type: "dcim.devices" }, { type: "extras.tags" }, { type: "nope" }] });
    assert.deepEqual(out.counts.slice(0, 2), [{ type: "dcim.devices", count: 2600 }, { type: "extras.tags", count: 1 }]);
    assert.match(out.counts[2].error, /unknown type/);
    for (const r of fake.state.requests.filter((x) => x.path !== "/api/status/")) assert.equal(r.query.get("limit"), "1");
  });

  it("searches several types and keeps only hits", async () => {
    const out = await call("search_objects", { q: "dev25", types: ["dcim.devices", "extras.tags"], limit: 2 });
    assert.deepEqual(Object.keys(out.hits), ["dcim.devices"]);
    assert.equal(out.hits["dcim.devices"].returned, 2);
    assert.deepEqual(out.hits["dcim.devices"].results[0], { id: 25, display: "dev25" });
  });

  it("maps changelog arguments to object-change filters", async () => {
    fake.route("GET", "/api/core/object-changes/", () => ({
      body: { count: 1, results: [{ id: 1, action: { value: "update", label: "Updated" }, prechange_data: { a: 1, b: 2 }, postchange_data: { a: 1, b: 3 } }] },
    }));
    const out = await call("get_changelog", { object_type: "dcim.devices", object_id: 5, request_id: "r1", since: "2026-01-01", data: "diff" });
    const query = fake.state.requests.at(-1).query;
    assert.equal(query.get("changed_object_type"), "dcim.device");
    assert.equal(query.get("changed_object_id"), "5");
    assert.equal(query.get("request_id"), "r1");
    assert.equal(query.get("time_after"), "2026-01-01");
    assert.deepEqual(out.results[0].diff, { b: [2, 3] });
    assert.equal(out.results[0].action, "update");
  });

  it("caps available-prefixes to limit and reports the full count", async () => {
    fake.route("GET", "/api/ipam/prefixes/9/available-prefixes/", () => ({ body: [{ prefix: "a" }, { prefix: "b" }, { prefix: "c" }] }));
    const out = await call("get_available_resources", { type: "ipam.prefixes", id: 9, kind: "prefixes", limit: 2 });
    assert.equal(out.count, 3);
    assert.equal(out.returned, 2);
    await assert.rejects(tools.call("get_available_resources", { type: "ipam.vlan-groups", id: 9, kind: "ips" }), /supports kind vlans/);
  });

  it("compacts a trace into near/cable/far segments", async () => {
    fake.route("GET", "/api/dcim/interfaces/3/trace/", () => ({
      body: [[[{ id: 3, url: "u", display: "eth0", device: { id: 1, name: "a" } }], { id: 9, url: "u", display: "#9", label: "c1", status: { value: "connected", label: "Connected" } }, [{ id: 4, url: "u", display: "eth1", device: { id: 2, name: "b" } }]]],
    }));
    const out = await call("trace_path", { type: "dcim.interfaces", id: 3 });
    assert.deepEqual(out.result, [{ near: [{ id: 3, display: "eth0", device: "a" }], cable: { id: 9, display: "#9", label: "c1", status: "connected" }, far: [{ id: 4, display: "eth1", device: "b" }] }]);
    await assert.rejects(tools.call("trace_path", { type: "dcim.devices", id: 1 }), /no trace or paths endpoint/);
  });

  it("lists occupied rack units", async () => {
    fake.route("GET", "/api/dcim/racks/4/elevation/", () => ({
      body: { count: 3, results: [{ id: 2, name: "U2", device: { id: 1, name: "sw" }, occupied: true }, { id: 1, name: "U1", device: null, occupied: false }, { id: 3, name: "U3", device: null, occupied: true }] },
    }));
    const out = await call("get_rack_elevation", { id: 4 });
    assert.deepEqual(out.results, [{ unit: 2, name: "U2", device: { id: 1, name: "sw" } }, { unit: 3, name: "U3", occupied: true }]);
    assert.equal(fake.state.requests.at(-1).query.get("face"), "front");
  });

  it("refuses GraphQL mutations without calling NetBox", async () => {
    assert.equal(isMutation("mutation { a }"), true);
    assert.equal(isMutation("  # comment\n subscription S { a }"), true);
    assert.equal(isMutation("{ device_list(filters: {name: {exact: \"mutation\"}}) { id } }"), false);
    assert.equal(isMutation("query Q { a }"), false);
    await assert.rejects(tools.call("graphql_query", { query: "mutation { x }" }), /read-only/);
    fake.route("POST", "/graphql/", (request) => ({ body: { data: { echo: request.body.query } } }));
    assert.deepEqual(await call("graphql_query", { query: "{ a }" }), { data: { echo: "{ a }" } });
  });

  it("dry_run validates and returns the request without sending it", async () => {
    const out = await call("create_objects", { type: "extras.tags", data: [{ name: "mcp-test-a", slug: "mcp-test-a" }], dry_run: true });
    assert.deepEqual(out, { dry_run: true, valid: true, method: "POST", path: "/api/extras/tags/", body: [{ name: "mcp-test-a", slug: "mcp-test-a" }] });
    assert.equal(fake.state.requests.length, 0);
    await assert.rejects(tools.call("create_objects", { type: "extras.tags", data: { name: "x", colour: "red" }, dry_run: true }), /unknown field "colour".*missing required field "slug"/);
    await assert.rejects(tools.call("create_objects", { type: "ipam.ip-addresses", data: { address: "192.0.2.1/24", status: "on" }, dry_run: true }), /not one of active/);
    await assert.rejects(tools.call("create_objects", { type: "core.object-changes", data: {}, dry_run: true }), /does not support create/);
  });

  it("creates, updates, and returns request ids", async () => {
    const created = await call("create_objects", { type: "extras.tags", data: { name: "mcp-test-b", slug: "mcp-test-b" } });
    assert.equal(created.request_id, "req-123");
    assert.equal(created.results[0].name, "mcp-test-b");
    const id = created.results[0].id;
    const single = await call("update_objects", { type: "extras.tags", id, data: { description: "one" } });
    assert.equal(single.results[0].description, "one");
    assert.equal(fake.state.requests.at(-1).path, `/api/extras/tags/${id}/`);
    const bulk = await call("update_objects", { type: "extras.tags", data: [{ id, color: "ff0000" }, { id: 7, color: "00ff00" }] });
    assert.equal(bulk.count, 2);
    assert.equal(fake.state.requests.at(-1).path, "/api/extras/tags/");
    await assert.rejects(tools.call("update_objects", { type: "extras.tags", data: [{ color: "ff0000" }] }), /integer "id"/);
  });

  it("allocates with validation and the assigned field removed", async () => {
    fake.route("POST", "/api/ipam/prefixes/5/available-ips/", (request) => ({ status: 201, body: request.body.map((item, index) => ({ id: 50 + index, address: `192.0.2.${index + 1}/24`, ...item })) }));
    const out = await call("allocate_available", { type: "ipam.prefixes", id: 5, data: [{ description: "mcp-test-ip" }, { description: "mcp-test-ip" }] });
    assert.equal(out.count, 2);
    assert.deepEqual(out.allocated_from, { type: "ipam.prefixes", id: 5, kind: "ips" });
    await assert.rejects(tools.call("allocate_available", { type: "ipam.prefixes", id: 5, kind: "prefixes", data: {}, dry_run: true }), /needs "prefix_length"/);
    await assert.rejects(tools.call("allocate_available", { type: "ipam.prefixes", id: 5, data: { address: "x" }, dry_run: true }), /unknown field "address"/);
  });

  it("refuses admin writes unless NETBOX_ALLOW_ADMIN_WRITES is set", async () => {
    await assert.rejects(tools.call("create_objects", { type: "users.tokens", data: { user: 1 }, dry_run: true }), /NETBOX_ALLOW_ADMIN_WRITES/);
    await assert.rejects(tools.call("update_objects", { type: "users.users", id: 1, data: { first_name: "x" }, dry_run: true }), /refused/);
    await assert.rejects(tools.call("delete_objects", { type: "core.data-sources", ids: [1], confirm: 1 }), /refused/);
    await assert.rejects(tools.call("create_objects", { type: "extras.webhooks", data: {}, dry_run: true }), /refused/);
    const admin = make({ allowAdminWrites: true });
    const out = JSON.parse(await admin.call("create_objects", { type: "users.tokens", data: { user: 1 }, dry_run: true }));
    assert.equal(out.valid, true);
  });

  it("delete requires confirm to equal the number of ids", async () => {
    await assert.rejects(tools.call("delete_objects", { type: "dcim.devices", ids: [1, 2], confirm: 1 }), /confirm must equal the number of ids \(2\)/);
    await assert.rejects(tools.call("delete_objects", { type: "dcim.devices", ids: [1, 1], confirm: 2 }), /duplicates/);
    assert.equal(fake.state.requests.length, 0);
  });

  it("delete reads targets first and refuses when any id is missing", async () => {
    await assert.rejects(tools.call("delete_objects", { type: "dcim.devices", ids: [1, 99999], confirm: 2 }), /nothing deleted.*99999/);
    assert.equal(fake.state.requests.some((r) => r.method === "DELETE"), false);
  });

  it("delete dry_run lists targets; live delete returns briefs", async () => {
    const dry = await call("delete_objects", { type: "dcim.devices", ids: [1, 2], confirm: 2, dry_run: true });
    assert.deepEqual(dry.would_delete, [{ id: 1, display: "dev1" }, { id: 2, display: "dev2" }]);
    assert.deepEqual(dry.body, [{ id: 1 }, { id: 2 }]);
    assert.equal(fake.state.requests.some((r) => r.method === "DELETE"), false);
    const live = await call("delete_objects", { type: "dcim.devices", ids: [1, 2], confirm: 2 });
    assert.equal(live.deleted, 2);
    assert.equal(live.request_id, "req-123");
    const single = await call("delete_objects", { type: "dcim.devices", ids: 3, confirm: 1 });
    assert.equal(single.objects[0].id, 3);
    assert.equal(fake.state.requests.at(-1).path, "/api/dcim/devices/3/");
    const remaining = await call("count_objects", { queries: [{ type: "dcim.devices" }] });
    assert.equal(remaining.counts[0].count, 2597);
  });

  it("delete dry_run warns about cascades and counts the main dependents", async () => {
    fake.route("GET", "/api/dcim/interfaces/", (request) => ({ body: { count: request.query.getAll("device_id").length * 138, results: [] } }));
    fake.route("GET", "/api/dcim/mac-addresses/", () => ({ body: { count: 109, results: [] } }));
    fake.route("GET", "/api/ipam/ip-addresses/", () => ({ status: 400, body: { detail: "bad filter" } }));
    fake.state.delayMs = 5;
    const dry = await call("delete_objects", { type: "dcim.devices", ids: [1, 2], confirm: 2, dry_run: true });
    fake.state.delayMs = 0;
    assert.match(dry.cascade, /would_delete lists only the named objects/);
    assert.match(dry.cascade, /interfaces.*modules.*inventory items.*IP addresses, MAC addresses/);
    const counts = Object.fromEntries(dry.cascade_counts.map((row) => [row.type, row]));
    assert.deepEqual(counts["dcim.interfaces"], { type: "dcim.interfaces", filter: "device_id", effect: "deleted", count: 276 });
    assert.equal(counts["dcim.mac-addresses"].count, 109);
    assert.equal(counts["dcim.modules"].count, 0);
    assert.match(counts["ipam.ip-addresses"].error, /HTTP 400: bad filter/);
    const countRequests = fake.state.requests.filter((r) => r.query.get("fields") === "id");
    assert.equal(countRequests.length, 5);
    for (const request of countRequests) {
      assert.equal(request.query.get("limit"), "1");
      assert.deepEqual(request.query.getAll("device_id"), ["1", "2"]);
    }
    assert.ok(fake.state.maxInflight <= 3, `peak ${fake.state.maxInflight}`);
    assert.equal(fake.state.requests.some((r) => r.method === "DELETE"), false);
  });

  it("gives other types the general cascade note without extra calls, and live deletes carry it", async () => {
    const dry = await call("delete_objects", { type: "extras.tags", ids: [7], confirm: 1, dry_run: true });
    assert.match(dry.cascade, /^would_delete lists only the named objects/);
    assert.equal(dry.cascade_counts, undefined);
    assert.equal(fake.state.requests.filter((r) => r.path !== "/api/status/").length, 1);
    const live = await call("delete_objects", { type: "dcim.devices", ids: [1], confirm: 1 });
    assert.match(live.cascade, /deletes each device's components/);
    assert.equal(fake.state.requests.filter((r) => r.query.get("fields") === "id").length, 0);
  });

  it("uses only catalog filters for cascade counts, a few per type", () => {
    const catalog = loadCatalog(catalogPath);
    for (const [key, rule] of Object.entries(CASCADES)) {
      assert.ok(catalog.data.types[key], key);
      assert.ok(rule.counts.length <= 5, key);
      for (const [target, filter] of rule.counts) {
        assert.deepEqual(checkFilters(catalog, resolveType(catalog, target), { [filter]: [1] }), [], `${key} -> ${target} ${filter}`);
      }
    }
  });

  it("sends bulk deletes in sequential batches of 25", async () => {
    const ids = Array.from({ length: 60 }, (_, index) => index + 1);
    const dry = await call("delete_objects", { type: "dcim.devices", ids, confirm: 60, dry_run: true });
    assert.equal(dry.batches, 3);
    const live = await call("delete_objects", { type: "dcim.devices", ids, confirm: 60 });
    assert.equal(live.deleted, 60);
    assert.deepEqual(live.request_ids, ["req-123", "req-123", "req-123"]);
    assert.equal(live.request_id, undefined);
    const deletes = fake.state.requests.filter((r) => r.method === "DELETE");
    assert.deepEqual(deletes.map((r) => r.body.length), [25, 25, 10]);
    assert.deepEqual(deletes[2].body.map((item) => item.id), ids.slice(50));
  });

  it("reports a partial delete precisely and stops at the failed batch", async () => {
    let calls = 0;
    fake.route("DELETE", "/api/dcim/devices/", () => (++calls === 2 ? { status: 400, body: { detail: "protected" } } : { status: 204 }));
    const ids = Array.from({ length: 60 }, (_, index) => index + 1);
    const error = await tools.call("delete_objects", { type: "dcim.devices", ids, confirm: 60 }).catch((e) => e);
    assert.match(error.message, /partial delete of dcim\.devices: 25 of 60 deleted \(ids: 1, 2,/);
    assert.match(error.message, /Batch 2 of 3 failed \(ids: 26, .*50\): NetBox DELETE .*HTTP 400: protected/);
    assert.match(error.message, /Not attempted \(ids: 51, .*60\)/);
    assert.equal(calls, 2);
  });

  it("tells the caller how to verify a timed-out write", async () => {
    fake.route("DELETE", "/api/dcim/devices/", async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { status: 204 };
    });
    const slow = make({ client: new NetBoxClient({ url: fake.url, token: TOKEN, writeTimeoutMs: 20 }) });
    const error = await slow.call("delete_objects", { type: "dcim.devices", ids: [1, 2], confirm: 2 }).catch((e) => e);
    assert.match(error.message, /timed out after 20 ms\. The write may have been applied/);
    assert.match(error.message, /get_changelog since="\d{4}-\d\d-\d\dT[^"]+Z"/);
    assert.match(error.message, /object_type="dcim\.devices" action="delete"/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fake.state.requests.filter((r) => r.method === "DELETE").length, 1);
  });

  it("describe_object_type shows only the operations this server allows", async () => {
    const tokens = await call("describe_object_type", { type: "users.tokens", sections: ["read"] });
    assert.equal(tokens.ops, "list get");
    assert.match(tokens.writes, /refused.*NETBOX_ALLOW_ADMIN_WRITES/);
    const admin = await call("describe_object_type", { type: "users.tokens", sections: ["read"] }, make({ allowAdminWrites: true }));
    assert.match(admin.ops, /create/);
    assert.equal(admin.writes, undefined);
    const readOnly = await call("describe_object_type", { type: "dcim.devices", sections: ["read"] }, make({ readOnly: true }));
    assert.equal(readOnly.ops, "list get");
    assert.match(readOnly.writes, /NETBOX_READ_ONLY/);
    const devicesType = await call("describe_object_type", { type: "dcim.devices", sections: ["read"] });
    assert.match(devicesType.ops, /bulk_delete/);
    assert.equal(devicesType.writes, undefined);
    const changes = await call("describe_object_type", { type: "core.object-changes", sections: ["read"] });
    assert.equal(changes.writes, undefined);
    const listed = await call("list_object_types", { app: "users" }, make({ readOnly: true }));
    assert.match(listed.note, /NETBOX_READ_ONLY/);
  });

  it("describe_object_type cuts long enums unless full_enums is set", async () => {
    const short = await tools.call("describe_object_type", { type: "dcim.interfaces", sections: ["fields"] });
    const full = await tools.call("describe_object_type", { type: "dcim.interfaces", sections: ["fields"], full_enums: true });
    assert.match(JSON.parse(short).fields.rf_channel, /values, first 25 shown; full_enums=true/);
    assert.doesNotMatch(JSON.parse(full).fields.rf_channel, /first 25 shown/);
    assert.ok(short.length < full.length / 2, `${short.length} vs ${full.length}`);
  });

  it("returns related objects brief when fields is given", async () => {
    const row = {
      id: 5, url: "u", name: "sw5",
      role: { id: 2, url: "u", display: "Switch", name: "Switch", slug: "switch", description: "", device_count: 9, _depth: 0 },
      status: { value: "active", label: "Active" },
    };
    fake.route("GET", "/api/dcim/devices/", () => ({ body: { count: 1, results: [row] } }));
    fake.route("GET", "/api/dcim/devices/5/", () => ({ body: row }));
    const list = await call("get_objects", { type: "dcim.devices", fields: ["id", "name", "role", "status"] });
    assert.deepEqual(list.results[0], { id: 5, name: "sw5", role: { id: 2, display: "Switch", slug: "switch" }, status: "active" });
    const one = await call("get_object", { type: "dcim.devices", id: 5, fields: ["role"] });
    assert.deepEqual(one.result.role, { id: 2, display: "Switch", slug: "switch" });
    const whole = await call("get_object", { type: "dcim.devices", id: 5 });
    assert.equal(whole.result.role.device_count, 9);
    const raw = await call("get_object", { type: "dcim.devices", id: 5, fields: ["role"], raw: true });
    assert.equal(raw.result.role._depth, 0);
  });

  it("projects write responses with fields", async () => {
    const created = await call("create_objects", { type: "extras.tags", data: { name: "mcp-test-c", slug: "mcp-test-c", color: "ff0000" }, fields: ["name", "bogus"] });
    assert.deepEqual(created.results[0], { id: created.results[0].id, name: "mcp-test-c" });
    assert.match(created.warnings.join(" "), /fields not readable on extras\.tags: bogus/);
    const updated = await call("update_objects", { type: "extras.tags", id: created.results[0].id, data: { description: "d" }, fields: ["description"] });
    assert.deepEqual(updated.results[0], { id: created.results[0].id, description: "d" });
    await assert.rejects(tools.call("create_objects", { type: "extras.tags", data: { name: "x", slug: "x" }, fields: "name" }), /fields must be an array/);
  });
});

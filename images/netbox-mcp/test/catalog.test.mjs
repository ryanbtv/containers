import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { checkFilters, describeFieldText, loadCatalog, resolveType, validatePayload } from "../src/catalog.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = join(root, "catalog.json");
const generator = join(root, "scripts", "build-catalog.mjs");

describe("committed catalog", () => {
  const catalog = loadCatalog(catalogPath);

  it("loads once, records the NetBox version, and stays small", () => {
    assert.equal(loadCatalog(catalogPath), catalog);
    assert.match(catalog.data.netbox_version, /^\d+\.\d+\.\d+$/);
    assert.ok(statSync(catalogPath).size < 1_500_000);
    assert.ok(Object.keys(catalog.data.types).length > 100);
  });

  it("resolves keys, content types, bare resources, and rejects ambiguity", () => {
    assert.equal(resolveType(catalog, "dcim.devices").key, "dcim.devices");
    assert.equal(resolveType(catalog, "dcim.device").key, "dcim.devices");
    assert.equal(resolveType(catalog, "ip-addresses").key, "ipam.ip-addresses");
    assert.equal(resolveType(catalog, "ip_addresses").key, "ipam.ip-addresses");
    assert.equal(resolveType(catalog, "/api/ipam/prefixes/").key, "ipam.prefixes");
    assert.throws(() => resolveType(catalog, "interfaces"), /ambiguous.*dcim\.interfaces.*virtualization\.interfaces/);
    assert.throws(() => resolveType(catalog, "dcim.widgets"), /unknown type/);
  });

  it("checks filter names and lookup suffixes", () => {
    const type = resolveType(catalog, "ipam.ip-addresses");
    assert.deepEqual(checkFilters(catalog, type, { status: "active", description__ic: "x", id__gte: 3, parent: "10.0.0.0/8" }), []);
    const errors = checkFilters(catalog, type, { bogus: 1, mask_length__ic: 2, limit: 5 });
    assert.equal(errors.length, 3);
    assert.match(errors.join(" "), /unknown filter "bogus"/);
    assert.match(errors.join(" "), /no "__ic" lookup/);
    assert.match(errors.join(" "), /tool argument/);
  });

  it("explains lookups readably and flags multi-hop filters", () => {
    const type = resolveType(catalog, "dcim.interfaces");
    const [isnull] = checkFilters(catalog, type, { lag_id__isnull: true });
    assert.match(isnull, /has no "__isnull" lookup/);
    assert.match(isnull, /pass \{"lag_id": null\}/);
    assert.match(isnull, /Supported: lag_id__n \(not equal\)/);
    assert.doesNotMatch(isnull, /has: n/);
    const [hop] = checkFilters(catalog, type, { device__site_id: 1 });
    assert.match(hop, /Multi-hop \(related-field\) filters are not supported/);
    assert.match(hop, /own "site_id" filter/);
    assert.match(hop, /device_id=<id>/);
    assert.match(hop, /graphql_query/);
    assert.match(checkFilters(catalog, type, { device__site__name: "x" })[0], /Multi-hop/);
    assert.doesNotMatch(checkFilters(catalog, type, { name__foo: "x" })[0], /Multi-hop/);
    assert.match(checkFilters(catalog, type, { device__status: "active" })[0], /"device_status" filter/);
    const [byName] = checkFilters(catalog, type, { device__name: "sw1" });
    assert.match(byName, /"device" itself usually matches/);
    assert.doesNotMatch(byName, /own "name" filter/);
    const [ic] = checkFilters(catalog, type, { name__contains: "x" });
    assert.match(ic, /use name__ic/);
    assert.match(ic, /name__ic \(contains\)/);
    assert.match(checkFilters(catalog, type, { description__isnull: true })[0], /use description__empty=true/);
    assert.deepEqual(checkFilters(catalog, type, { name__ic: "x", lag_id__n: 3 }), []);
  });

  it("cuts long enums short unless full listing is asked for", () => {
    const { fields } = resolveType(catalog, "dcim.interfaces");
    const short = describeFieldText(fields.rf_channel);
    assert.equal(short, describeFieldText(fields.rf_channel, { fullEnums: true }));
    const cut = describeFieldText(fields.rf_channel, { fullEnums: false });
    assert.match(cut, new RegExp(`\\(${fields.rf_channel.e.length} values, first 25 shown; full_enums=true lists all\\)`));
    assert.ok(cut.length < 800);
    assert.equal(describeFieldText(fields.mode, { fullEnums: false }), describeFieldText(fields.mode));
  });

  it("validates payloads: unknown fields, required fields, enums, and types", () => {
    const { fields } = resolveType(catalog, "ipam.ip-addresses");
    assert.deepEqual(validatePayload(fields, { address: "192.0.2.1/24", status: "active", tags: [{ name: "x" }] }, { mode: "create" }), []);
    const errors = validatePayload(fields, [{ status: "bogus", colour: 1 }, { address: 5 }], { mode: "create" });
    assert.match(errors.join("\n"), /\[0\] "status" value "bogus" is not one of active\|/);
    assert.match(errors.join("\n"), /\[0\] unknown field "colour"/);
    assert.match(errors.join("\n"), /\[0\] missing required field "address"/);
    assert.match(errors.join("\n"), /\[1\] "address" expects string/);
    assert.deepEqual(validatePayload(fields, [{ id: 3, description: "x" }], { mode: "update", bulk: true }), []);
    assert.match(validatePayload(fields, [{ description: "x" }], { mode: "update", bulk: true }).join(), /integer "id"/);
    assert.match(validatePayload(fields, { id: 1, address: "x" }, { mode: "create" }).join(), /"id" is not allowed/);
    assert.deepEqual(validatePayload(fields, { vrf: null }, { mode: "update" }), []);
  });
});

describe("catalog generator", { skip: !existsSync(generator) && "generator is not shipped in the image" }, () => {
  it("builds compact entries from an OpenAPI schema", async () => {
    const { buildCatalog, compactFilters } = await import(generator);
    const schema = {
      openapi: "3.0.3",
      info: { version: "9.9.1-Docker (9.9)" },
      paths: {
        "/api/dcim/widgets/": {
          get: {
            parameters: [
              { in: "query", name: "name" }, { in: "query", name: "name__ic" }, { in: "query", name: "limit" },
              ...["empty", "gt", "gte", "lt", "lte", "n"].map((s) => ({ in: "query", name: `id__${s}` })), { in: "query", name: "id" },
            ],
            responses: { 200: { content: { "application/json": { schema: { $ref: "#/components/schemas/PaginatedWidgetList" } } } } },
          },
          post: { requestBody: { content: { "application/json": { schema: { oneOf: [{ $ref: "#/components/schemas/WritableWidgetRequest" }] } } } } },
        },
        "/api/dcim/widgets/{id}/": { get: {}, patch: {}, delete: {} },
        "/api/dcim/widgets/{id}/trace/": { get: {} },
        "/api/dcim/sites/": {
          get: { responses: { 200: { content: { "application/json": { schema: { $ref: "#/components/schemas/PaginatedSiteList" } } } } } },
        },
      },
      components: {
        schemas: {
          PaginatedWidgetList: { properties: { results: { items: { $ref: "#/components/schemas/Widget" } } } },
          PaginatedSiteList: { properties: { results: { items: { $ref: "#/components/schemas/Site" } } } },
          Widget: { properties: { id: {}, name: {}, site: {} } },
          Site: { properties: { id: {} } },
          WritableWidgetRequest: {
            required: ["name"],
            properties: {
              name: { type: "string" },
              status: { type: "string", enum: ["on", "off", "", null], nullable: true },
              site: { oneOf: [{ type: "integer" }, { $ref: "#/components/schemas/BriefSiteRequest" }] },
              id: { type: "integer", readOnly: true },
            },
          },
        },
      },
    };
    const catalog = buildCatalog(schema);
    assert.equal(catalog.netbox_version, "9.9.1");
    const widget = catalog.types["dcim.widgets"];
    assert.deepEqual(widget.ops, ["list", "get", "create", "update", "delete"]);
    assert.equal(widget.ct, "dcim.widget");
    assert.equal(widget.filters, "id:# name:ic");
    assert.deepEqual(widget.fields, {
      name: { t: "string", r: 1 },
      status: { t: "string", e: ["on", "off"], n: 1 },
      site: { t: "ref", ref: "dcim.sites" },
    });
    assert.deepEqual(widget.special, { trace: { m: ["GET"] } });
    assert.equal(compactFilters([]), "");
  });
});

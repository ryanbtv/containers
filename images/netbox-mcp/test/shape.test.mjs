import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { brief, capList, capText, project, shape, shapeRow } from "../src/shape.mjs";

describe("output shaping", () => {
  it("strips urls, nulls, empty strings, empty tags/custom_fields, and collapses choices", () => {
    const input = {
      id: 1,
      url: "u",
      display_url: "d",
      name: "sw1",
      serial: "",
      rack: null,
      status: { value: "active", label: "Active" },
      site: { id: 2, url: "u", name: "dc1", description: "" },
      tags: [],
      custom_fields: {},
      list: [{ id: 3, url: "u" }],
    };
    assert.deepEqual(shape(input), { id: 1, name: "sw1", status: "active", site: { id: 2, name: "dc1" }, list: [{ id: 3 }] });
  });

  it("keeps non-empty tags, and custom-field keys even when null", () => {
    assert.deepEqual(shape({ tags: [{ id: 1, name: "a" }], custom_fields: { a: null, b: 2, c: "" } }), { tags: [{ id: 1, name: "a" }], custom_fields: { a: null, b: 2, c: null } });
    assert.deepEqual(shape({ custom_fields: { a: null } }), { custom_fields: { a: null } });
    assert.deepEqual(shape({ custom_fields: { ref: { id: 2, url: "u", display: "x" } } }), { custom_fields: { ref: { id: 2, display: "x" } } });
  });

  it("reduces objects to brief references", () => {
    assert.deepEqual(brief({ id: 4, display: "eth0", name: "eth0", device: { id: 1, name: "sw1" }, url: "x" }), { id: 4, display: "eth0", device: "sw1" });
  });

  it("briefs top-level related objects for fields= output and keeps choices", () => {
    const row = {
      id: 1,
      name: "sw1",
      role: { id: 2, url: "u", display: "Switch", name: "Switch", slug: "switch", description: "", device_count: 9, _depth: 0 },
      site: { id: 3, url: "u", display: "DC1 (dc1)", name: "DC1", slug: "dc1" },
      status: { value: "active", label: "Active" },
      tags: [{ id: 4, url: "u", display: "core", name: "core", slug: "core", color: "fff" }],
      custom_fields: { owner: null },
    };
    assert.deepEqual(shapeRow(row, { fields: ["role"] }), {
      id: 1, name: "sw1", role: { id: 2, display: "Switch", slug: "switch" }, site: { id: 3, display: "DC1 (dc1)", name: "DC1", slug: "dc1" },
      status: "active", tags: [{ id: 4, display: "core", slug: "core" }], custom_fields: { owner: null },
    });
    assert.equal(shapeRow(row, { fields: ["role"], raw: true }), row);
    assert.equal(shapeRow(row).role.device_count, 9);
    assert.deepEqual(project(row, ["name", "nope"]), { id: 1, name: "sw1" });
  });
});

describe("output caps", () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({ id: index + 1, name: "x".repeat(100) }));

  it("leaves small output alone", () => {
    const text = capList({ count: 2, returned: 2, results: rows.slice(0, 2) }, 10_000);
    assert.equal(JSON.parse(text).truncated, undefined);
  });

  it("drops trailing rows and reports the next offset", () => {
    const text = capList({ count: 500, returned: 200, results: rows }, 5_000, { offset: 100 });
    const parsed = JSON.parse(text);
    assert.ok(Buffer.byteLength(text) <= 5_000);
    assert.ok(parsed.returned > 0 && parsed.returned < 200);
    assert.equal(parsed.results.length, parsed.returned);
    assert.equal(parsed.count, 500);
    assert.equal(parsed.truncated.next_offset, 100 + parsed.returned);
    assert.equal(parsed.truncated.rows_omitted, 200 - parsed.returned);
  });

  it("reports the next cursor in start mode", () => {
    const parsed = JSON.parse(capList({ count: 500, returned: 200, results: rows }, 5_000, { cursor: true }));
    assert.equal(parsed.truncated.next_start, parsed.results.at(-1).id + 1);
  });

  it("caps plain text with a notice", () => {
    const text = capText("y".repeat(20_000), 5_000);
    assert.ok(Buffer.byteLength(text) <= 5_000);
    assert.match(text, /truncated: output exceeded 5000 bytes/);
  });
});

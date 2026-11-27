// Backwards compatibility with azure-mcp 3.0.0-beta.49's `kusto` tool. The
// fixture is the verbatim learn output captured from the running azure-mcp.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { COMMANDS } from "../src/commands.mjs";
import { ROUTER_DESCRIPTION, ROUTER_SCHEMA, Tools } from "../src/tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureText = readFileSync(join(here, "fixtures", "azure-mcp-3.0.0-beta.49-kusto-learn.json"), "utf8").trim();
const fixture = JSON.parse(fixtureText);
const COMPAT = ["kusto_sample", "kusto_query", "kusto_cluster_list", "kusto_cluster_get", "kusto_database_list", "kusto_table_list", "kusto_table_schema"];

const tools = (config = {}, mode = "both") => new Tools({ kusto: {}, arm: {}, config: { enableWrites: false, ...config }, mode });
const learnEntries = (instance) => JSON.parse(instance.learnText().split("\n\n").slice(1).join("\n\n"));

describe("azure-mcp compatibility", () => {
  it("lists the same seven commands, in the same order, flagged compat", () => {
    assert.deepEqual(fixture.map((entry) => entry.command), COMPAT);
    assert.deepEqual(COMMANDS.filter((command) => command.compat).map((command) => command.name), COMPAT);
  });

  it("learn output starts with the seven commands, byte-identical to azure-mcp", () => {
    const entries = learnEntries(tools());
    assert.equal(JSON.stringify(entries.slice(0, 7)), fixtureText);
  });

  it("learn text keeps azure-mcp's header", async () => {
    const result = await tools().call("kusto", { intent: "list", learn: true });
    assert.match(result.content[0].text, /^Here are the available commands and their input schema for 'kusto' tool\.\nIf you do not find a suitable "command", run again with the "learn=true" to get a list of available commands and their parameters\.\nNext, identify the command you want to execute and run again with the "command" and "parameters" arguments, respecting "required" parameters if present\.\n\n\[/);
    assert.equal(result.isError, undefined);
  });

  it("an intent without a command returns the learn text, as azure-mcp does", async () => {
    const result = await tools().call("kusto", { intent: "what can you do" });
    assert.match(result.content[0].text, /^Here are the available commands/);
  });

  it("a call with neither command nor learn returns the help text, not an error", async () => {
    const result = await tools().call("kusto", {});
    assert.match(result.content[0].text, /^The "command" parameter is required when not learning\./);
    assert.equal(result.isError, undefined);
  });

  it("the router tool keeps azure-mcp's name, schema, and description", () => {
    const router = tools().list().find((tool) => tool.name === "kusto");
    assert.equal(JSON.stringify(router.inputSchema), JSON.stringify({
      type: "object",
      properties: {
        intent: { type: "string", description: "The intent of the operation to perform." },
        command: { type: "string", description: "The command to execute against the specified tool." },
        parameters: { type: "object", description: "The parameters to pass to the tool command." },
        learn: { type: "boolean", description: "To learn about the tool and its supported child tools and parameters.", default: false },
      },
      required: ["intent"],
      additionalProperties: false,
    }));
    assert.equal(router.inputSchema, ROUTER_SCHEMA);
    assert.equal(router.description, ROUTER_DESCRIPTION);
    assert.ok(router.description.startsWith("Kusto operations - Commands for managing and querying Azure Data Explorer (Kusto) resources."));
    assert.ok(router.description.endsWith('This tool is a hierarchical MCP command router.\nTo invoke a command, set "command" and wrap its args in "parameters".\nSet "learn=true" to discover available sub commands.'));
  });

  it("each flat compat tool matches azure-mcp's all-tools definition", () => {
    const listed = new Map(tools().list().map((tool) => [tool.name, tool]));
    for (const entry of fixture) {
      const tool = listed.get(entry.command);
      assert.ok(tool, entry.command);
      assert.equal(tool.description, entry.description);
      assert.equal(JSON.stringify(tool.inputSchema), JSON.stringify(entry.inputSchema));
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool.annotations.destructiveHint, false);
    }
  });
});

describe("tool modes and write gating", () => {
  it("both mode lists the router and every read tool, and no write tool", () => {
    const names = tools().list().map((tool) => tool.name);
    assert.equal(names[0], "kusto");
    for (const name of COMPAT) assert.ok(names.includes(name));
    assert.ok(names.includes("kusto_query_v2"));
    assert.ok(!names.some((name) => ["kusto_command_write", "kusto_query_cancel", "kusto_ingest_stream"].includes(name)));
  });

  it("namespace mode lists only the router", () => {
    assert.deepEqual(tools({}, "namespace").list().map((tool) => tool.name), ["kusto"]);
  });

  it("all mode lists no router", () => {
    assert.ok(!tools({}, "all").list().some((tool) => tool.name === "kusto"));
  });

  it("writes appear as flat tools only, never behind the router", () => {
    const instance = tools({ enableWrites: true });
    const names = instance.list().map((tool) => tool.name);
    for (const name of ["kusto_command_write", "kusto_query_cancel", "kusto_ingest_stream"]) assert.ok(names.includes(name), name);
    const routed = learnEntries(instance).map((entry) => entry.command);
    assert.ok(!routed.some((name) => ["kusto_command_write", "kusto_query_cancel", "kusto_ingest_stream"].includes(name)));
    assert.deepEqual(tools({ enableWrites: true }, "namespace").list().map((tool) => tool.name), ["kusto", "kusto_command_write", "kusto_query_cancel", "kusto_ingest_stream"]);
  });

  it("refuses a write tool that is not enabled", async () => {
    const result = await tools().call("kusto_command_write", { command: ".drop table T", confirm: true, "cluster-uri": "https://a.kusto.windows.net" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown tool/);
  });

  it("the router refuses write commands even when writes are enabled", async () => {
    const result = await tools({ enableWrites: true }).call("kusto", { intent: "x", command: "kusto_command_write", parameters: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^The command 'kusto_command_write' is not available for the 'kusto' tool\.\nAvailable commands: kusto_cluster_get, kusto_cluster_list, kusto_command, /);
    assert.match(result.content[0].text, /\nSelect the command that best matches the current intent\. Use "learn=true" with an empty "intent" to get command descriptions and parameter schemas without executing a command\.$/);
    assert.ok(!result.content[0].text.includes("kusto_command_write,"));
  });

  it("write tools carry destructive or non-read-only annotations", () => {
    const listed = new Map(tools({ enableWrites: true }).list().map((tool) => [tool.name, tool]));
    assert.equal(listed.get("kusto_command_write").annotations.destructiveHint, true);
    assert.equal(listed.get("kusto_ingest_stream").annotations.readOnlyHint, false);
    assert.equal(listed.get("kusto_query_cancel").annotations.readOnlyHint, false);
  });

  it("every tool name fits Bifrost's 64-character limit with a 5-character client prefix", () => {
    for (const tool of tools({ enableWrites: true }).list()) {
      assert.ok(`kusto-${tool.name}`.length <= 64, tool.name);
      assert.match(tool.name, /^[a-z0-9_]+$/);
    }
  });
});

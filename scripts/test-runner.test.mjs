import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  COVERAGE_COMPONENT_ENV,
  COVERAGE_SUMMARY_ENV,
  coverageReporter,
  coverageRow,
  coverageSummaryCollector,
} from "./test-coverage-reporter.mjs";
import {
  coverageSummaryHeader,
  discoverComponents,
  parseArgs,
  run,
  testArgs,
} from "./test.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runner = resolve(repoRoot, "scripts", "test.mjs");
const reporter = resolve(repoRoot, "scripts", "test-coverage-reporter.mjs");
const expectedTests = [
  "images/netbox-mcp/test/catalog.test.mjs",
  "images/netbox-mcp/test/client.test.mjs",
  "images/netbox-mcp/test/server.test.mjs",
  "images/netbox-mcp/test/shape.test.mjs",
  "images/netbox-mcp/test/tools.test.mjs",
  ".github/scripts/image-build-storage.test.mjs",
  ".github/scripts/select-images.test.mjs",
  "scripts/test-runner.test.mjs",
];

describe("repository test runner", () => {
  it("accepts only its three supported invocation forms", () => {
    assert.deepEqual(parseArgs([]), { coverage: false, list: false });
    assert.deepEqual(parseArgs(["--coverage"]), { coverage: true, list: false });
    assert.deepEqual(parseArgs(["--list"]), { coverage: false, list: true });
    assert.throws(() => parseArgs(["--unknown"]), /unknown arguments/);
    assert.throws(() => parseArgs(["--list", "--coverage"]), /unknown arguments/);
  });

  it("discovers the exact direct-test inventory", () => {
    const inventory = discoverComponents(repoRoot);
    assert.deepEqual(inventory.map(({ name }) => name), [
      "netbox-mcp",
      "pipeline-scripts",
      "test-runner",
    ]);
    const tests = inventory.flatMap((component) => component.tests.map((test) =>
      resolve(component.cwd, test).slice(repoRoot.length + 1),
    ));
    assert.deepEqual(tests.sort(), expectedTests.sort());
  });

  it("uses native awareness-only coverage without threshold flags", () => {
    const component = discoverComponents(repoRoot)[0];
    const args = testArgs(component, true);
    assert.ok(args.includes("--experimental-test-coverage"));
    assert.ok(args.includes("--test-coverage-include-all"));
    assert.ok(args.includes("--test-coverage-include=src/*.mjs"));
    assert.ok(args.includes("--test-coverage-exclude=**/*.test.cjs"));
    assert.ok(args.includes("--test-coverage-exclude=**/*.test.cts"));
    assert.ok(args.includes("--test-coverage-exclude=**/*.test.js"));
    assert.ok(args.includes("--test-coverage-exclude=**/*.test.mjs"));
    assert.ok(args.includes("--test-coverage-exclude=**/*.test.mts"));
    assert.ok(args.includes("--test-coverage-exclude=**/*.test.ts"));
    assert.ok(args.includes("--test-coverage-exclude=test/*.test.ts"));
    assert.equal(args.some((arg) => /^--test-coverage-(?:lines|branches|functions)(?:=|$)/.test(arg)), false);

    const byName = (name) => discoverComponents(repoRoot).find((entry) => entry.name === name);
    const stackArgs = testArgs(byName("pipeline-scripts"), true);
    assert.ok(stackArgs.includes("--test-coverage-exclude=.github/scripts/*.test.mjs"));

    const netboxMcpArgs = testArgs(byName("netbox-mcp"), true);
    assert.ok(netboxMcpArgs.includes("--test-coverage-exclude=test/*.test.mjs"));
    assert.ok(netboxMcpArgs.includes("--test-coverage-include=src/*.mjs"));

    const testRunner = byName("test-runner");
    assert.ok(testRunner.coverageIncludes.includes("test-coverage-reporter.mjs"));

    const reporterArgs = testArgs(component, true, true);
    assert.deepEqual(reporterArgs.filter((arg) => arg.startsWith("--test-reporter=")), [
      `--test-reporter=${reporter}`,
    ]);
    assert.equal(reporterArgs.some((arg) => arg.startsWith("--test-reporter-destination=")), false);
    assert.equal(testArgs(component, false, true).some((arg) => arg.startsWith("--test-reporter")), false);
  });

  it("derives one formatted row from the structured coverage event", () => {
    const event = coverageEvent(91.25, 82.5, 100);
    assert.equal(coverageRow(event, "component"), "| component | 91.25% | 82.50% | 100.00% |\n");
    assert.equal(coverageRow({ type: "test:pass", data: {} }, "component"), null);
    assert.equal(coverageRow(coverageEvent(-1, 82.5, 100), "component"), null);
    assert.equal(coverageRow(event, ""), null);
  });

  it("buffers the final valid totals and appends exactly one row", () => {
    const warnings = [];
    const rows = [];
    const collector = coverageSummaryCollector({
      component: "component",
      summaryPath: "/unused",
      append: (_path, row) => rows.push(row),
      warn: (message) => warnings.push(message),
    });
    collector.observe(coverageEvent(10, 20, 30));
    collector.observe(coverageEvent(40, 50, 60));
    collector.finish();
    assert.deepEqual(rows, ["| component | 40.00% | 50.00% | 60.00% |\n"]);
    assert.deepEqual(warnings, [
      "warning: coverage summary: component: duplicate coverage events; using final valid totals",
    ]);
  });

  it("forwards duplicate coverage events while appending one final row", async () => {
    const forwarded = [];
    const rows = [];
    const warnings = [];
    const output = [];
    const events = [coverageEvent(10, 20, 30), coverageEvent(40, 50, 60)];
    const specFactory = () => new Transform({
      writableObjectMode: true,
      transform(event, _encoding, callback) {
        forwarded.push(event);
        callback(null, `${event.type}\n`);
      },
    });

    for await (const chunk of coverageReporter(events, {
      component: "component",
      summaryPath: "/unused",
      append: (_path, row) => rows.push(row),
      warn: (message) => warnings.push(message),
      specFactory,
    })) output.push(chunk);

    assert.deepEqual(forwarded, events);
    assert.deepEqual(output.map(String), ["test:coverage\n", "test:coverage\n"]);
    assert.deepEqual(rows, ["| component | 40.00% | 50.00% | 60.00% |\n"]);
    assert.deepEqual(warnings, [
      "warning: coverage summary: component: duplicate coverage events; using final valid totals",
    ]);
  });

  it("renders a coherent append-only summary header without a repository aggregate", () => {
    const header = coverageSummaryHeader();
    assert.equal(header, [
      "",
      "## Native Node Coverage",
      "",
      "> Coverage is awareness-only. No thresholds are enforced. Component source scopes overlap, so no repository-wide aggregate is calculated.",
      "",
      "| Component | Line | Branch | Function |",
      "| --- | ---: | ---: | ---: |",
      "",
    ].join("\n"));
    assert.doesNotMatch(header, /\| (?:total|repository) \|/i);
  });

  it("lists inventory without recursively invoking the suite", () => {
    const result = spawnSync(process.execPath, [runner, "--list"], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /netbox-mcp \(5\)/);
    assert.match(result.stdout, /pipeline-scripts \(2\)/);
    assert.match(result.stdout, /test-runner \(1\)/);
    assert.match(result.stdout, /total: 8/);
  });

  it("rejects unknown arguments before running tests", () => {
    const result = spawnSync(process.execPath, [runner, "--unknown"], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown arguments: --unknown/);
    assert.match(result.stderr, /usage: node scripts\/test\.mjs/);
    assert.doesNotMatch(result.stdout, /=== netbox-mcp/);
  });

  it("continues after failures without recursive fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "repository-test-runner-"));
    const definitions = [
      { name: "failing", cwd: "failing", testDirectories: ["."], coverageIncludes: [] },
      { name: "empty", cwd: "empty", testDirectories: ["."], coverageIncludes: [] },
      { name: "later", cwd: "later", testDirectories: ["."], coverageIncludes: [] },
    ];
    for (const component of definitions) mkdirSync(join(root, component.cwd));
    writeFileSync(join(root, "failing", "first.test.mjs"), "");
    writeFileSync(join(root, "later", "last.test.mjs"), "");

    const calls = [];
    const messages = [];
    const output = {
      log: (message) => messages.push(message),
      error: (message) => messages.push(message),
    };
    try {
      const status = run([], root, (_executable, args, options) => {
        calls.push({ args, cwd: options.cwd });
        return { status: options.cwd.endsWith("failing") ? 1 : 0 };
      }, definitions, output);
      assert.equal(status, 1);
      assert.deepEqual(calls.map(({ cwd }) => cwd), [join(root, "failing"), join(root, "later")]);
      assert.deepEqual(calls.map(({ args }) => args.at(-1)), ["first.test.mjs", "last.test.mjs"]);
      assert.ok(messages.includes("no direct tests found for empty"));
      assert.ok(messages.includes("\nfailed components: failing, empty"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("initializes once and gives sequential children controlled summary context", () => {
    const fixture = runnerFixture();
    const summaryPath = join(fixture.root, "summary.md");
    const calls = [];
    try {
      writeFileSync(summaryPath, "existing summary\n");
      const status = run(["--coverage"], fixture.root, (_executable, args, options) => {
        calls.push({ args, env: options.env });
        const index = calls.length - 1;
        appendFileSync(summaryPath, coverageRow(coverageEvent(90 + index, 80 + index, 70 + index), options.env[COVERAGE_COMPONENT_ENV]));
        return { status: 0 };
      }, fixture.definitions, fixture.output, { GITHUB_STEP_SUMMARY: summaryPath });

      assert.equal(status, 0);
      const summary = readFileSync(summaryPath, "utf8");
      assert.match(summary, /^existing summary\n\n## Native Node Coverage/);
      assert.match(summary, /\| first \| 90\.00% \| 80\.00% \| 70\.00% \|\n\| second \| 91\.00% \| 81\.00% \| 71\.00% \|/);
      assert.deepEqual(calls.map(({ env }) => env[COVERAGE_COMPONENT_ENV]), ["first", "second"]);
      assert.ok(calls.every(({ env }) => env[COVERAGE_SUMMARY_ENV] === summaryPath));
      assert.ok(calls.every(({ args }) => args.includes(`--test-reporter=${reporter}`)));
      assert.deepEqual(fixture.warnings, []);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not let coverage reporting mask test or runner failures", () => {
    for (const childStatus of [1, null]) {
      const fixture = runnerFixture();
      try {
        let first = true;
        const status = run(["--coverage"], fixture.root, () => {
          if (first) {
            first = false;
            return { status: childStatus };
          }
          return { status: 0 };
        }, fixture.definitions, fixture.output, { GITHUB_STEP_SUMMARY: join(fixture.root, "summary.md") });
        assert.equal(status, 1);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it("does not enable row reporters when summary initialization fails", () => {
    const fixture = runnerFixture();
    const calls = [];
    try {
      const status = run(["--coverage"], fixture.root, (_executable, args, options) => {
        calls.push({ args, env: options.env });
        return { status: 0 };
      }, fixture.definitions, fixture.output, {
        GITHUB_STEP_SUMMARY: fixture.root,
        [COVERAGE_COMPONENT_ENV]: "stale-component",
        [COVERAGE_SUMMARY_ENV]: "/stale-summary",
      });
      assert.equal(status, 0);
      assert.ok(fixture.warnings.some((message) => /could not initialize/.test(message)));
      assert.ok(calls.every(({ args }) => !args.some((arg) => arg.startsWith("--test-reporter="))));
      assert.ok(calls.every(({ env }) => !(COVERAGE_COMPONENT_ENV in env) && !(COVERAGE_SUMMARY_ENV in env)));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not write summaries in normal or list mode", () => {
    const fixture = runnerFixture();
    const summaryPath = join(fixture.root, "summary.md");
    try {
      const calls = [];
      assert.equal(run([], fixture.root, (_executable, _args, options) => {
        calls.push(options.env);
        return { status: 0 };
      }, fixture.definitions, fixture.output, {
        GITHUB_STEP_SUMMARY: summaryPath,
        [COVERAGE_COMPONENT_ENV]: "stale-component",
        [COVERAGE_SUMMARY_ENV]: "/stale-summary",
      }), 0);
      assert.equal(existsSync(summaryPath), false);
      assert.ok(calls.every((environment) =>
        !(COVERAGE_COMPONENT_ENV in environment) && !(COVERAGE_SUMMARY_ENV in environment)
      ));
      calls.length = 0;
      assert.equal(run(["--coverage"], fixture.root, (_executable, args, options) => {
        calls.push(options.env);
        assert.equal(args.some((arg) => arg.startsWith("--test-reporter=")), false);
        return { status: 0 };
      }, fixture.definitions, fixture.output, {
        [COVERAGE_COMPONENT_ENV]: "stale-component",
        [COVERAGE_SUMMARY_ENV]: "/stale-summary",
      }), 0);
      assert.ok(calls.every((environment) =>
        !(COVERAGE_COMPONENT_ENV in environment) && !(COVERAGE_SUMMARY_ENV in environment)
      ));
      assert.equal(run(["--list"], fixture.root, () => { throw new Error("should not spawn"); }, fixture.definitions,
        fixture.output, { GITHUB_STEP_SUMMARY: summaryPath }), 0);
      assert.equal(existsSync(summaryPath), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps a real reporter-time summary write failure non-gating", () => {
    const root = mkdtempSync(join(tmpdir(), "repository-coverage-reporters-"));
    const testFile = join(root, "passing.test.mjs");
    writeFileSync(testFile, 'import test from "node:test"; test("visible spec test", () => {});\n');
    try {
      const result = spawnSync(process.execPath, [
        "--experimental-test-coverage",
        `--test-reporter=${reporter}`,
        "--test",
        testFile,
      ], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT")),
          [COVERAGE_COMPONENT_ENV]: "failing-write",
          [COVERAGE_SUMMARY_ENV]: root,
        },
      });
      assert.equal(result.status, 0, result.stderr);
      const terminalOutput = `${result.stdout}${result.stderr}`;
      assert.match(terminalOutput, /visible spec test/);
      assert.match(terminalOutput, /all files/);
      assert.match(terminalOutput, /warning: coverage summary: failing-write: could not append row:/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps malformed coverage handling non-gating", () => {
    const warnings = [];
    const collector = coverageSummaryCollector({
      component: "malformed",
      summaryPath: "/unused",
      append: () => { throw new Error("must not append"); },
      warn: (message) => warnings.push(message),
    });
    collector.observe(coverageEvent(Number.NaN, 80, 70));
    collector.finish();
    assert.deepEqual(warnings, ["warning: coverage summary: malformed: invalid coverage summary"]);

    const brokenWarningCollector = coverageSummaryCollector({
      component: "broken-warning-stream",
      summaryPath: "/unused",
      append: () => {},
      warn: () => { throw new Error("warning stream unavailable"); },
    });
    assert.doesNotThrow(() => {
      brokenWarningCollector.observe(coverageEvent(Number.NaN, 80, 70));
      brokenWarningCollector.finish();
    });
  });

  it("warns after a real completed run with no coverage event", () => {
    const root = mkdtempSync(join(tmpdir(), "repository-coverage-missing-"));
    const testFile = join(root, "passing.test.mjs");
    writeFileSync(testFile, 'import test from "node:test"; test("no coverage", () => {});\n');
    try {
      const result = spawnSync(process.execPath, [`--test-reporter=${reporter}`, "--test", testFile], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT")),
          [COVERAGE_COMPONENT_ENV]: "missing",
          [COVERAGE_SUMMARY_ENV]: join(root, "summary.md"),
        },
      });
      assert.equal(result.status, 0, result.stderr);
      const terminalOutput = `${result.stdout}${result.stderr}`;
      assert.match(terminalOutput, /no coverage/);
      assert.match(terminalOutput, /warning: coverage summary: missing: missing coverage summary/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the CI workflow dependency-free and awareness-only", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "tests.yml"), "utf8");
    assert.match(workflow, /^on:\n  push:\n    branches: \[main\]\n  pull_request:/m);
    assert.match(workflow, /^permissions:\n  contents: read$/m);
    assert.match(workflow, /uses: actions\/checkout@v7/);
    assert.match(workflow, /uses: actions\/setup-node@v6/);
    assert.match(workflow, /node-version: 26\.7\.0/);
    assert.match(workflow, /run: node scripts\/test\.mjs --coverage/);
    assert.doesNotMatch(workflow, /\b(?:npm|pnpm|yarn|bun)\b|cache:/);
  });
});

function coverageEvent(line, branch, functionCoverage) {
  return {
    type: "test:coverage",
    data: {
      summary: {
        totals: {
          coveredLinePercent: line,
          coveredBranchPercent: branch,
          coveredFunctionPercent: functionCoverage,
        },
      },
    },
  };
}

function runnerFixture() {
  const root = mkdtempSync(join(tmpdir(), "repository-test-runner-summary-"));
  const definitions = [
    { name: "first", cwd: "first", testDirectories: ["."], coverageIncludes: ["*.mjs"] },
    { name: "second", cwd: "second", testDirectories: ["."], coverageIncludes: ["*.mjs"] },
  ];
  for (const component of definitions) {
    mkdirSync(join(root, component.cwd));
    writeFileSync(join(root, component.cwd, `${component.name}.test.mjs`), "");
  }
  const warnings = [];
  return {
    root,
    definitions,
    warnings,
    output: {
      log: () => {},
      error: () => {},
      warn: (message) => warnings.push(message),
    },
  };
}

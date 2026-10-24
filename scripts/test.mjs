#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { COVERAGE_COMPONENT_ENV, COVERAGE_SUMMARY_ENV } from "./test-coverage-reporter.mjs";

const TEST_EXTENSIONS = ["cjs", "cts", "js", "mjs", "mts", "ts"];
const TEST_FILE = new RegExp(`\\.test\\.(?:${TEST_EXTENSIONS.join("|")})$`);

export const components = [
  {
    name: "netbox-mcp",
    cwd: "images/netbox-mcp",
    testDirectories: ["test"],
    coverageIncludes: ["server.mjs", "src/*.mjs", "scripts/*.mjs"],
  },
  {
    name: "pipeline-scripts",
    cwd: ".",
    testDirectories: [".github/scripts"],
    coverageIncludes: [".github/scripts/*.mjs"],
  },
  {
    name: "test-runner",
    cwd: "scripts",
    testDirectories: ["."],
    coverageIncludes: ["test.mjs", "test-coverage-reporter.mjs"],
  },
];

const coverageReporter = fileURLToPath(new URL("./test-coverage-reporter.mjs", import.meta.url));

export function parseArgs(args) {
  if (args.length === 0) return { coverage: false, list: false };
  if (args.length === 1 && args[0] === "--coverage") return { coverage: true, list: false };
  if (args.length === 1 && args[0] === "--list") return { coverage: false, list: true };
  throw new Error(`unknown arguments: ${args.join(" ")}`);
}

export function discoverComponents(repoRoot, definitions = components) {
  return definitions.map((component) => {
    const cwd = resolve(repoRoot, component.cwd);
    const tests = component.testDirectories.flatMap((directory) => {
      const absoluteDirectory = resolve(cwd, directory);
      return readdirSync(absoluteDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && TEST_FILE.test(entry.name))
        .map((entry) => relative(cwd, resolve(absoluteDirectory, entry.name)));
    }).sort();
    return { ...component, cwd, tests };
  });
}

export function testArgs(component, coverage, summaryEnabled = false) {
  const args = [];
  if (coverage) {
    args.push("--experimental-test-coverage", "--test-coverage-include-all");
    for (const pattern of component.coverageIncludes) {
      args.push(`--test-coverage-include=${pattern}`);
    }
    for (const extension of TEST_EXTENSIONS) {
      for (const directory of component.testDirectories) {
        args.push(`--test-coverage-exclude=${directory}/*.test.${extension}`);
      }
      args.push(`--test-coverage-exclude=**/*.test.${extension}`);
    }
    if (summaryEnabled) args.push(`--test-reporter=${coverageReporter}`);
  }
  return [...args, "--test", ...component.tests];
}

export function coverageSummaryHeader() {
  return [
    "",
    "## Native Node Coverage",
    "",
    "> Coverage is awareness-only. No thresholds are enforced. Component source scopes overlap, so no repository-wide aggregate is calculated.",
    "",
    "| Component | Line | Branch | Function |",
    "| --- | ---: | ---: | ---: |",
    "",
  ].join("\n");
}

function warn(output, message) {
  try {
    (output.warn ?? output.error).call(output, `warning: coverage summary: ${message}`);
  } catch {
    // A broken warning stream must not turn coverage reporting into a gate.
  }
}

export function run(
  args = process.argv.slice(2),
  repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  spawn = spawnSync,
  definitions = components,
  output = console,
  environment = process.env,
  io = {},
) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    output.error(error.message);
    output.error("usage: node scripts/test.mjs [--coverage|--list]");
    return 2;
  }

  const inventory = discoverComponents(repoRoot, definitions);
  if (options.list) {
    for (const component of inventory) {
      output.log(`${component.name} (${component.tests.length})`);
      for (const test of component.tests) output.log(`  ${relative(repoRoot, resolve(component.cwd, test))}`);
    }
    output.log(`total: ${inventory.reduce((count, component) => count + component.tests.length, 0)}`);
    return 0;
  }

  const failures = [];
  const summaryPath = options.coverage ? environment.GITHUB_STEP_SUMMARY : undefined;
  const appendFile = io.appendFileSync ?? appendFileSync;
  let summaryEnabled = false;

  if (summaryPath) {
    try {
      appendFile(summaryPath, coverageSummaryHeader(), "utf8");
      summaryEnabled = true;
    } catch (error) {
      warn(output, `could not initialize ${summaryPath}: ${error.message}`);
    }
  }

  for (const component of inventory) {
    output.log(`\n=== ${component.name} (${component.tests.length} test files) ===`);
    if (component.tests.length === 0) {
      output.error(`no direct tests found for ${component.name}`);
      failures.push(component.name);
      continue;
    }
    const childEnvironment = { ...environment };
    delete childEnvironment[COVERAGE_COMPONENT_ENV];
    delete childEnvironment[COVERAGE_SUMMARY_ENV];
    if (summaryEnabled) {
      childEnvironment[COVERAGE_COMPONENT_ENV] = component.name;
      childEnvironment[COVERAGE_SUMMARY_ENV] = summaryPath;
    }
    const result = spawn(process.execPath, testArgs(component, options.coverage, summaryEnabled), {
      cwd: component.cwd,
      stdio: "inherit",
      env: childEnvironment,
    });
    if (result.status !== 0) failures.push(component.name);
  }

  if (failures.length > 0) {
    output.error(`\nfailed components: ${failures.join(", ")}`);
    return 1;
  }
  output.log(`\nall ${inventory.length} components passed`);
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) process.exitCode = run();

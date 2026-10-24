import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../workflows/docker-build-pipeline.yml", import.meta.url), "utf8");
const section = (start, end) => workflow.slice(workflow.indexOf(start), workflow.indexOf(end, workflow.indexOf(start)));

test("runner disk is freed before setup actions and keeps the hosted tool cache", () => {
  const cleanup = section("      - name: Free runner disk space", "      - name: Set up QEMU");
  assert.match(cleanup, /sudo rm -rf [^\n]*\/opt\/hostedtoolcache\/CodeQL/);
  assert.doesNotMatch(cleanup, /\/opt\/hostedtoolcache\/\*|\/opt\/hostedtoolcache\n/);
  assert.ok(workflow.indexOf("Free runner disk space") < workflow.indexOf("Set up QEMU"));
  assert.ok(workflow.indexOf("Free runner disk space") < workflow.indexOf("Set up Docker Buildx"));
});

test("selected-image matrix, security gate, and PR publication restriction stay intact", () => {
  assert.match(workflow, /run: node \.github\/scripts\/select-images\.mjs/);
  assert.match(workflow, /matrix: \$\{\{ fromJson\(needs\.discover\.outputs\.matrix\) \}\}/);
  assert.match(workflow, /fail-fast: false/);
  const build = section("      - name: Build (load locally for scan)", "      # Images authored");
  assert.match(build, /load: true/);
  assert.match(build, /platforms: linux\/amd64/);
  const scan = section("      - name: Trivy (image scan)", "      - name: Login to GHCR");
  assert.match(scan, /image-ref: \$\{\{ matrix\.name \}\}:scan/);
  assert.match(scan, /exit-code: '1'/);
  assert.match(scan, /ignore-unfixed: true/);
  assert.match(scan, /severity: CRITICAL,HIGH/);
  assert.doesNotMatch(scan, /continue-on-error|skip-dirs|skip-files/);
  const publish = section("      - name: Build and push (multi-arch)", "  openchamber:");
  assert.match(publish, /if: github\.event_name != 'pull_request'/);
  assert.match(publish, /platforms: \$\{\{ env\.PLATFORMS \}\}/);
});

test("no retired Qwen image build remains", () => {
  assert.doesNotMatch(workflow, /qwen/i);
});

test("public-repository safety: hosted runners, no pull_request_target, scoped permissions", () => {
  const workflows = [workflow, readFileSync(new URL("../workflows/tests.yml", import.meta.url), "utf8")];
  for (const text of workflows) {
    assert.doesNotMatch(text, /^\s*pull_request_target\s*:/m);
    assert.doesNotMatch(text, /self-hosted/);
    for (const [, runner] of text.matchAll(/runs-on: (.+)/g)) assert.equal(runner, "ubuntu-latest");
  }
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(workflow, /org\.opencontainers\.image\.source=https:\/\/github\.com\/\$\{\{ github\.repository \}\}/);
});

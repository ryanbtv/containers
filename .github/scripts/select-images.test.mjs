import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { changedFiles, checkSummary, inventory, publicationDecision, selectImages, selectionSummary, sharedInputs } from "./select-images.mjs";

const script = fileURLToPath(new URL("./select-images.mjs", import.meta.url));
const workflow = readFileSync(new URL("../workflows/docker-build-pipeline.yml", import.meta.url), "utf8");
const names = (selection) => selection.decisions.filter(({ selected }) => selected).map(({ name }) => name);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "select-images-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, content = "FROM scratch\n") => {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  };
  const git = (...args) => execFileSync("git", args, {
    cwd: root, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Selector test");
  git("config", "commit.gpgsign", "false");
  for (const image of ["arc-runner", "homelab-act", "netbox-mcp"]) write(`images/${image}/Dockerfile`);
  write("images/openchamber/UPSTREAM_REF", "v1.0.0\n");
  const commit = () => {
    git("add", ".");
    git("commit", "--no-verify", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  const before = commit();
  const select = (eventName, event, extra = {}) => selectImages({ root, eventName, event, ...extra });
  const push = (base = before) => select("push", { before: base, after: git("rev-parse", "HEAD") });
  return { root, write, git, commit, before, select, push };
}

test("current repository inventory is the three local builds plus upstream OpenChamber", () => {
  assert.deepEqual(inventory(fileURLToPath(new URL("../../", import.meta.url))).map(({ name }) => name),
    ["arc-runner", "homelab-act", "netbox-mcp", "openchamber"]);
});

test("each image directory selects only itself, including hidden and metadata inputs", (t) => {
  const f = fixture(t);
  for (const image of ["arc-runner", "homelab-act", "netbox-mcp", "openchamber"]) {
    for (const file of ["README.md", "VERSION", "TAG", ".trivyignore", ".hidden/nested file\nname"]) {
      const base = f.git("rev-parse", "HEAD");
      f.write(`images/${image}/${file}`);
      f.commit();
      const selection = f.push(base);
      assert.deepEqual(names(selection), [image]);
      assert.equal(selection.build_required, String(image !== "openchamber"));
      assert.equal(selection.openchamber_required, String(image === "openchamber"));
      assert.deepEqual(selection.matrix.include, image === "openchamber" ? [] : [{ name: image }]);
      assert.match(selection.decisions.find(({ selected }) => selected).reason, /Changed:/);
    }
  }
  const base = f.git("rev-parse", "HEAD");
  f.write("images/openchamber/UPSTREAM_REF", "v2.0.0\n");
  f.commit();
  assert.deepEqual(names(f.push(base)), ["openchamber"]);
});

test("unrelated files, root docker docs, and similarly named directories select none", (t) => {
  const f = fixture(t);
  for (const path of ["docs/note.md", "images/README.md", "images/netbox-mcp-extra/README.md", ".github/scripts/select-images.test.mjs"]) f.write(path);
  f.commit();
  const selection = f.push();
  assert.deepEqual(names(selection), []);
  assert.deepEqual(selection.matrix, { include: [] });
  assert.equal(selection.build_required, "false");
  assert.equal(selection.openchamber_required, "false");
  assert.match(selectionSummary(selection), /Skipped.*No changed files/);
});

test("shared executable inputs each select every current image", (t) => {
  const f = fixture(t);
  for (const path of sharedInputs) {
    const base = f.git("rev-parse", "HEAD");
    f.write(path);
    f.commit();
    assert.equal(names(f.push(base)).length, 4);
    assert.match(f.push(base).decisions[0].reason, /Shared build input/);
  }
});

test("push compares event before/after across multiple commits, not just HEAD parent", (t) => {
  const f = fixture(t);
  f.write("images/homelab-act/VERSION", "1.0.0\n");
  f.commit();
  f.write("images/netbox-mcp/.trivyignore");
  const after = f.commit();
  f.write("images/arc-runner/TAG");
  f.commit(); // The checkout may have advanced beyond the event.
  assert.deepEqual(names(f.select("push", { before: f.before, after })), ["homelab-act", "netbox-mcp"]);
});

test("PR uses merge-base to exclude base-branch-only changes", (t) => {
  const f = fixture(t);
  f.git("switch", "-c", "topic");
  f.write("images/netbox-mcp/VERSION");
  const head = f.commit();
  f.git("switch", "main");
  f.write("images/arc-runner/TAG");
  const base = f.commit();
  f.git("switch", "topic");
  const selection = f.select("pull_request", { pull_request: { base: { sha: base }, head: { sha: head } } });
  assert.deepEqual(names(selection), ["netbox-mcp"]);
});

test("rename across images selects both sides; new, renamed and deleted build definitions use current inventory", (t) => {
  const f = fixture(t);
  f.write("images/homelab-act/shared file", "same\n");
  let base = f.commit();
  renameSync(join(f.root, "images/homelab-act/shared file"), join(f.root, "images/netbox-mcp/shared file"));
  f.commit();
  assert.deepEqual(names(f.push(base)), ["homelab-act", "netbox-mcp"]);
  base = f.git("rev-parse", "HEAD");
  renameSync(join(f.root, "images/homelab-act"), join(f.root, "images/renamed-image"));
  f.write("images/new-image/Dockerfile");
  rmSync(join(f.root, "images/arc-runner"), { recursive: true });
  rmSync(join(f.root, "images/openchamber"), { recursive: true });
  f.commit();
  assert.deepEqual(names(f.push(base)), ["new-image", "renamed-image"]);
  assert.equal(f.push(base).openchamber_required, "false");
});

test("manual named selection forces exactly one build, blank forces all, invalid fails", (t) => {
  const f = fixture(t);
  for (const image of ["arc-runner", "homelab-act", "netbox-mcp", "openchamber"]) {
    assert.deepEqual(names(f.select("workflow_dispatch", { inputs: { image } })), [image]);
  }
  assert.equal(names(f.select("workflow_dispatch", { inputs: { image: "" } })).length, 4);
  assert.equal(names(f.select("workflow_dispatch", {})).length, 4);
  for (const image of ["missing", " ../netbox-mcp", "netbox-mcp\n", true]) {
    assert.throws(() => f.select("workflow_dispatch", { inputs: { image } }), /Unknown image|must be a string/);
  }
  assert.throws(() => f.select("schedule", {}), /Unsupported event/);
  for (const event of [null, [], "invalid"]) {
    assert.throws(() => f.select("workflow_dispatch", event), /Invalid event configuration/);
  }
});

test("missing history, zero commits, failed merge-base or diff conservatively select all", (t) => {
  const f = fixture(t);
  for (const event of [{}, { before: "0".repeat(40), after: f.before }, { before: "a".repeat(40), after: f.before }]) {
    const selection = f.select("push", event);
    assert.equal(names(selection).length, 4);
    assert.match(selection.warning, /conservatively/);
  }
  for (const git of [() => { throw new Error("timeout"); }, () => "incomplete diff"]) {
    const selection = f.select("push", { before: f.before, after: f.before }, { git });
    assert.equal(names(selection).length, 4);
    assert.ok(selection.warning);
  }
  const pr = f.select("pull_request", { pull_request: { base: { sha: f.before }, head: { sha: f.before } } },
    { git: () => { throw new Error("merge-base failed"); } });
  assert.equal(names(pr).length, 4);
  assert.deepEqual(changedFiles(f.root, "push", { before: f.before, after: f.before }), []);
});

test("malformed inventory fails rather than hiding it with conservative fallback", (t) => {
  const f = fixture(t);
  f.write("images/openchamber/UPSTREAM_REF", " ");
  assert.throws(() => f.push(), /one non-empty ref/);
  f.write("images/openchamber/UPSTREAM_REF", "v1\nv2\n");
  assert.throws(() => f.push(), /one non-empty ref/);
  f.write("images/openchamber/UPSTREAM_REF", "v1\n");
  f.write("images/openchamber/Dockerfile");
  assert.throws(() => f.push(), /dedicated upstream build/);
  rmSync(join(f.root, "images/openchamber/Dockerfile"));
  f.write("images/INVALID/Dockerfile");
  assert.throws(() => f.push(), /Invalid image name/);
  rmSync(join(f.root, "images/INVALID"), { recursive: true });
  symlinkSync(join(f.root, "images/netbox-mcp"), join(f.root, "images/link"));
  assert.throws(() => f.push(), /Symlink image directory/);
  rmSync(join(f.root, "images/link"));
  rmSync(join(f.root, "images/netbox-mcp/Dockerfile"));
  symlinkSync(join(f.root, "images/homelab-act/Dockerfile"), join(f.root, "images/netbox-mcp/Dockerfile"));
  assert.throws(() => f.push(), /Not a regular build definition/);
  rmSync(join(f.root, "images/netbox-mcp/Dockerfile"));
  symlinkSync(join(f.root, "missing"), join(f.root, "images/netbox-mcp/Dockerfile"));
  assert.throws(() => f.push(), /Not a regular build definition/);
});

test("empty current inventory can skip all after deletion", (t) => {
  const f = fixture(t);
  for (const image of inventory(f.root)) rmSync(join(f.root, "images", image.name), { recursive: true });
  f.write("images/README.md");
  f.commit();
  assert.deepEqual(names(f.push()), []);
  assert.match(selectionSummary(f.push()), /No current build definitions/);
});

test("summary exhaustively requires discovery and exactly the expected job outcomes", () => {
  const results = ["success", "skipped", "failure", "cancelled", "", "unknown"];
  for (const discover of results) for (const buildRequired of ["true", "false", ""]) {
    for (const openRequired of ["true", "false", ""]) for (const build of results) for (const open of results) {
      const errors = checkSummary({ DISCOVER_RESULT: discover, BUILD_REQUIRED: buildRequired,
        OPENCHAMBER_REQUIRED: openRequired, BUILD_RESULT: build, OPENCHAMBER_RESULT: open });
      const valid = discover === "success" && buildRequired !== "" && openRequired !== "" &&
        build === (buildRequired === "true" ? "success" : "skipped") &&
        open === (openRequired === "true" ? "success" : "skipped");
      assert.equal(errors.length === 0, valid, JSON.stringify({ discover, buildRequired, openRequired, build, open }));
    }
  }
});

test("CLI writes explicit outputs, escaped selected/skipped reasons, warns fallback and fails malformed config", (t) => {
  const f = fixture(t);
  const eventPath = join(f.root, "event.json");
  const output = join(f.root, "output");
  const summary = join(f.root, "summary");
  const run = (eventName, event, args = [], extra = {}) => {
    writeFileSync(eventPath, JSON.stringify(event));
    return spawnSync(process.execPath, [script, ...args], { cwd: f.root, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: eventName,
        GITHUB_WORKSPACE: f.root, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...extra } });
  };
  const result = run("workflow_dispatch", { inputs: { image: "netbox-mcp" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, "utf8"), 'matrix={"include":[{"name":"netbox-mcp"}]}\nbuild_required=true\nopenchamber_required=false\n');
  assert.match(readFileSync(summary, "utf8"), /netbox-mcp \| Selected \| Explicit manual/);
  assert.match(readFileSync(summary, "utf8"), /openchamber \| Skipped/);
  assert.match(run("push", {}).stderr, /::warning::/);
  assert.equal(run("workflow_dispatch", { inputs: { image: "invalid" } }).status, 1);
  assert.equal(run("workflow_dispatch", {}, ["--bad"]).status, 1);
  writeFileSync(eventPath, "not JSON");
  assert.equal(spawnSync(process.execPath, [script], { timeout: 10_000, env: {
    ...process.env, GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: "push", GITHUB_WORKSPACE: f.root,
  } }).status, 1);
  const summaryEnv = { DISCOVER_RESULT: "success", BUILD_REQUIRED: "false", OPENCHAMBER_REQUIRED: "true",
    BUILD_RESULT: "skipped", OPENCHAMBER_RESULT: "success" };
  assert.equal(run("push", {}, ["--summary"], summaryEnv).status, 0);
  assert.equal(run("push", {}, ["--summary"], { ...summaryEnv, OPENCHAMBER_RESULT: "skipped" }).status, 1);
  assert.match(selectionSummary({ decisions: [{ name: "image", selected: true, reason: "a|b\n<script>`" }] }), /a&#124;b &lt;script&gt;&#96;/);
});

test("actual workflow concurrency retains A/B/C pushes when C changes only docs", (t) => {
  const concurrency = workflow.match(/^concurrency:\n((?:  [^\n]*\n)+)/m)?.[1];
  assert.ok(concurrency);
  const group = concurrency.match(/^  group: (.+)$/m)?.[1];
  const queue = concurrency.match(/^  queue: (.+)$/m)?.[1];
  const cancel = concurrency.match(/^  cancel-in-progress: (.+)$/m)?.[1];
  assert.equal(group, "docker-build-${{ github.event_name == 'pull_request' && github.ref || 'publication' }}");
  assert.equal(queue, "max");
  assert.equal(cancel, "false");
  assert.doesNotMatch(workflow, /^    concurrency:/m); // No dropping job-level lane.

  // Evaluate the exact asserted group form and the configured queue policy.
  const groupFor = (event, ref) => group.replace(/\$\{\{.*\}\}/, event === "pull_request" ? ref : "publication");
  assert.equal(groupFor("push", "refs/heads/main"), groupFor("workflow_dispatch", "refs/heads/topic"));
  assert.notEqual(groupFor("pull_request", "refs/pull/1/merge"), groupFor("push", "refs/heads/main"));
  assert.notEqual(groupFor("pull_request", "refs/pull/1/merge"), groupFor("pull_request", "refs/pull/2/merge"));
  const waiting = [];
  const enqueue = (name) => {
    if (queue === "single") waiting.length = 0;
    assert.ok(waiting.length < 100);
    waiting.push(name);
  };
  const f = fixture(t);
  const a = f.before;
  f.write("images/netbox-mcp/VERSION", "1.1.0\n");
  const b = f.commit();
  f.write("knowledge/docs-only.md");
  const c = f.commit();
  const bSelection = f.select("push", { before: a, after: b });
  const cSelection = f.select("push", { before: b, after: c });
  enqueue("B"); // A is still running.
  enqueue("C");
  assert.deepEqual(waiting, ["B", "C"]);
  assert.deepEqual(names(bSelection), ["netbox-mcp"]);
  assert.deepEqual(names(cSelection), []);
  f.git("remote", "add", "origin", f.root);
  f.git("switch", "--detach", b);
  assert.equal(publicationDecision({ root: f.root, image: "netbox-mcp", ref: "refs/heads/main" }).publish, true);
});

test("freshness permits unrelated main advances, rejects relevant inputs and works with reversed arrival order", (t) => {
  for (const path of ["images/netbox-mcp/VERSION", "images/netbox-mcp/.hidden", ...sharedInputs]) {
    const f = fixture(t);
    f.git("remote", "add", "origin", f.root);
    const candidate = f.before;
    f.write(path, "new relevant content\n");
    const current = f.commit();
    // Newer run completes first, then an older run starts from its own source.
    const latest = publicationDecision({ root: f.root, image: "netbox-mcp", ref: "refs/heads/main" });
    assert.equal(latest.publish, true);
    f.git("switch", "--detach", candidate);
    const stale = publicationDecision({ root: f.root, image: "netbox-mcp", ref: "refs/heads/main" });
    assert.equal(stale.publish, false, path);
    assert.match(stale.reason, /current main has different/);
    // Newer run arriving after the older run remains eligible too.
    f.git("switch", "--detach", current);
    assert.equal(publicationDecision({ root: f.root, image: "netbox-mcp", ref: "refs/heads/main" }).publish, true);
  }
  const f = fixture(t);
  f.git("remote", "add", "origin", f.root);
  f.write("images/homelab-act/TAG");
  f.write("images/README.md");
  f.commit();
  f.git("switch", "--detach", f.before);
  assert.equal(publicationDecision({ root: f.root, image: "netbox-mcp", ref: "refs/heads/main" }).publish, true);
});

test("OpenChamber pointer changes and image removals suppress old publications", (t) => {
  const f = fixture(t);
  f.git("remote", "add", "origin", f.root);
  f.write("images/openchamber/UPSTREAM_REF", "v2.0.0\n");
  rmSync(join(f.root, "images/netbox-mcp"), { recursive: true });
  f.commit();
  f.git("switch", "--detach", f.before);
  for (const image of ["openchamber", "netbox-mcp"]) {
    assert.equal(publicationDecision({ root: f.root, image, ref: "refs/heads/main" }).publish, false);
  }
});

test("main advancing during a publish is repaired by its queued run, never by a late stale overwrite", (t) => {
  const f = fixture(t);
  f.git("remote", "add", "origin", f.root);
  const input = { root: f.root, image: "netbox-mcp", ref: "refs/heads/main" };
  assert.equal(publicationDecision(input).publish, true);
  // Main advances after the old run's final check, while it holds the lane.
  // The new run cannot publish until the old build-and-push releases it.
  f.write("images/netbox-mcp/VERSION", "2.0.0\n");
  const current = f.commit();
  let published = f.before;
  if (publicationDecision(input).publish) published = current;
  assert.equal(published, current);
  f.git("switch", "--detach", f.before);
  if (publicationDecision(input).publish) published = f.before;
  assert.equal(published, current);
});

test("publication fails closed on fetch/diff errors and preserves explicit non-latest branch dispatch", (t) => {
  const f = fixture(t);
  const input = { root: f.root, image: "netbox-mcp", ref: "refs/heads/main" };
  assert.throws(() => publicationDecision(input)); // No remote configured.
  for (const status of [undefined, 2, 128]) {
    assert.throws(() => publicationDecision({ ...input, git: (args) => {
      if (args[0] === "diff") throw Object.assign(new Error("diff failed"), { status });
      return "";
    } }), /diff failed/);
  }
  assert.throws(() => publicationDecision({ ...input, image: "bad" }), /Unknown publication image/);
  assert.throws(() => publicationDecision({ ...input, ref: "refs/pull/1/merge" }), /branch ref/);
  const branch = publicationDecision({ ...input, ref: "refs/heads/topic", git: () => { throw new Error("must not fetch"); } });
  assert.equal(branch.publish, true);
  assert.match(branch.reason, /non-latest/);
});

test("publication CLI emits an explicit gate, reports stale steps, and forbids PR invocation", (t) => {
  const f = fixture(t);
  f.git("remote", "add", "origin", f.root);
  f.write("images/netbox-mcp/VERSION", "2.0.0\n");
  const current = f.commit();
  f.git("switch", "--detach", f.before);
  const output = join(f.root, "publication-output");
  const summary = join(f.root, "publication-summary");
  const run = (extra = {}) => spawnSync(process.execPath, [script, "--publication"], {
    cwd: f.root, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, GITHUB_WORKSPACE: f.root, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main",
      IMAGE_NAME: "netbox-mcp", GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...extra },
  });
  const stale = run();
  assert.equal(stale.status, 0, stale.stderr);
  assert.equal(readFileSync(output, "utf8"), "publish=false\n");
  assert.match(readFileSync(summary, "utf8"), /Publication skipped/);
  assert.equal(run({ GITHUB_EVENT_NAME: "pull_request" }).status, 1);
  f.git("switch", "--detach", current);
  assert.equal(run({ GITHUB_EVENT_NAME: "workflow_dispatch" }).status, 0);
  assert.match(readFileSync(output, "utf8"), /publish=true\n$/);
  assert.equal(run({ IMAGE_NAME: "missing" }).status, 1);
});

test("workflow preserves stable checks, independent gates, full local history, and PR publication restrictions", () => {
  assert.match(workflow, /  discover:\n/);
  assert.match(workflow, /  build-summary:\n/);
  assert.match(workflow, /needs: \[discover, build, openchamber\]\n    if: always\(\)/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /if: needs\.discover\.outputs\.build_required == 'true'/);
  assert.match(workflow, /if: needs\.discover\.outputs\.openchamber_required == 'true'/);
  assert.match(workflow, /run: node \.github\/scripts\/select-images\.mjs --summary/);
  assert.doesNotMatch(workflow, /gh pr diff|schedule:|paths:|outputs\.relevant|outputs\.empty/);
  assert.match(workflow, /^  pull_request:\s*$/m);
  for (const match of workflow.matchAll(/      - name: (Login to GHCR|Build and push[^\n]*)\n([\s\S]*?)(?=\n      - |\n  [a-z]|$)/g)) {
    assert.match(match[2], /if: github\.event_name != 'pull_request'/);
  }
  for (const job of [workflow.slice(workflow.indexOf("  build:"), workflow.indexOf("  openchamber:")),
    workflow.slice(workflow.indexOf("  openchamber:"), workflow.indexOf("  build-summary:"))]) {
    assert.match(job, /name: Check publication freshness\n        id: publication\n        if: github\.event_name != 'pull_request'/);
    assert.match(job, /run: node \.github\/scripts\/select-images\.mjs --publication\n\n      - name: Build and push/);
    assert.match(job, /name: Build and push[^\n]*\n(?:        id: image_publish\n)?        if: github\.event_name != 'pull_request' && steps\.publication\.outputs\.publish == 'true'/);
  }
  const open = workflow.slice(workflow.indexOf("  openchamber:"), workflow.indexOf("  build-summary:"));
  assert.match(open, /continue-on-error: true/);
  assert.match(open, /exit-code: '0'/);
});

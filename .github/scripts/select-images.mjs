import { appendFileSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const sharedInputs = [
  ".github/workflows/docker-build-pipeline.yml",
  ".github/scripts/select-images.mjs",
];

const present = (path) => {
  try { lstatSync(path); return true; }
  catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

// Discover build definitions, not every directory under images/. Deleted images
// are deliberately absent: this workflow never deletes published packages.
export function inventory(root) {
  const images = [];
  for (const entry of readdirSync(join(root, "images"), { withFileTypes: true })) {
    const directory = join(root, "images", entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink image directory: ${entry.name}`);
    if (!entry.isDirectory()) continue;
    const dockerfile = join(directory, "Dockerfile");
    const pointer = join(directory, "UPSTREAM_REF");
    const special = entry.name === "openchamber";
    if (!special && !present(dockerfile)) continue;
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(entry.name)) {
      throw new Error(`Invalid image name: ${entry.name}`);
    }
    if (special && present(dockerfile)) throw new Error("openchamber must use its dedicated upstream build");
    const definition = special ? pointer : dockerfile;
    if (!lstatSync(definition).isFile()) throw new Error(`Not a regular build definition: ${definition}`);
    if (special && !/^\S+$/.test(readFileSync(pointer, "utf8").trim())) {
      throw new Error("openchamber/UPSTREAM_REF must contain one non-empty ref");
    }
    images.push({ name: entry.name, kind: special ? "upstream" : "local" });
  }
  return images.sort((a, b) => a.name.localeCompare(b.name));
}

export function changedFiles(root, eventName, event, git = (args) => execFileSync("git", args, {
  cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
})) {
  const sha = (value) => {
    if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) || /^0+$/.test(value)) {
      throw new Error("Missing or unavailable event commit");
    }
    return value;
  };
  let base;
  let head;
  if (eventName === "pull_request") {
    head = sha(event.pull_request?.head?.sha);
    base = sha(git(["merge-base", sha(event.pull_request?.base?.sha), head]).trim());
  } else if (eventName === "push") {
    base = sha(event.before);
    head = sha(event.after);
  } else {
    throw new Error(`Unsupported diff event: ${eventName}`);
  }
  // --no-renames includes both the old and new paths. NUL preserves whitespace,
  // newlines, and hidden files without shell parsing or Git path quoting.
  const output = git(["diff", "--no-renames", "--name-only", "-z", base, head, "--"]);
  if (output && !output.endsWith("\0")) throw new Error("Incomplete NUL-delimited diff");
  return output ? output.slice(0, -1).split("\0") : [];
}

export function selectImages({ root, eventName, event, git }) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Invalid event configuration");
  const images = inventory(root); // Invalid inventory is fatal, never a fallback.
  let files = [];
  let allReason;
  let warning;
  let manual;
  if (eventName === "workflow_dispatch") {
    manual = event.inputs?.image ?? "";
    if (typeof manual !== "string") throw new Error("Manual image input must be a string");
    if (manual && !images.some(({ name }) => name === manual)) throw new Error(`Unknown image: ${manual}`);
    if (!manual) allReason = "Manual force rebuild of all images";
  } else if (["push", "pull_request"].includes(eventName)) {
    try {
      files = changedFiles(root, eventName, event, git);
      const shared = files.filter((file) => sharedInputs.includes(file));
      if (shared.length) allReason = `Shared build input changed: ${shared.join(", ")}`;
    } catch {
      warning = "Could not determine the complete Git diff; conservatively building all current images.";
      allReason = warning;
    }
  } else {
    throw new Error(`Unsupported event: ${eventName}`);
  }
  const decisions = images.map((image) => {
    const changed = files.filter((file) => file.startsWith(`images/${image.name}/`));
    const selected = Boolean(allReason || manual === image.name || changed.length);
    const reason = allReason || (manual === image.name ? "Explicit manual image selection" :
      changed.length ? `Changed: ${changed.join(", ")}` : manual ? "Not selected by manual input" : "No changed files in image directory");
    return { ...image, selected, reason };
  });
  const local = decisions.filter((image) => image.selected && image.kind === "local");
  return {
    decisions, warning,
    matrix: { include: local.map(({ name }) => ({ name })) },
    build_required: String(local.length > 0),
    openchamber_required: String(decisions.some((image) => image.selected && image.kind === "upstream")),
  };
}

// Publishing workflows hold one non-dropping concurrency lane. A newer run
// cannot publish between this check and our push. Main may advance while the
// push builds, but its queued run will follow us. Arrival order need not match
// commit order, so an older run must not overwrite newer relevant sources.
export function publicationDecision({ root, image, ref, git = (args) => execFileSync("git", args, {
  cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
}) }) {
  if (!inventory(root).some(({ name }) => name === image)) throw new Error(`Unknown publication image: ${image}`);
  if (typeof ref !== "string" || !ref.startsWith("refs/heads/")) throw new Error("Publication requires a branch ref");
  if (ref !== "refs/heads/main") {
    return { publish: true, reason: "Explicit branch dispatch; existing non-latest tag policy applies" };
  }
  // Fetch failure is fatal. Unlike discovery, publication must fail closed.
  git(["fetch", "--no-tags", "--depth=1", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  try {
    git(["diff", "--quiet", "--no-ext-diff", "HEAD", "refs/remotes/origin/main", "--",
      `images/${image}`, ...sharedInputs]);
  } catch (error) {
    if (error.status !== 1) throw error;
    return { publish: false, reason: "Publication skipped: current main has different image or shared build inputs; its relevant push owns publication" };
  }
  return { publish: true, reason: "Image and shared build inputs match current main (unrelated newer commits are allowed)" };
}

const escapeMarkdown = (text) => text.replace(/[&<>|`\r\n]/g, (char) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "|": "&#124;", "`": "&#96;", "\r": " ", "\n": " " })[char]);

export function selectionSummary(selection) {
  return ["## Container build selection", "", "| Image | Decision | Reason |", "| --- | --- | --- |",
    ...selection.decisions.map(({ name, selected, reason }) =>
      `| ${name} | ${selected ? "Selected" : "Skipped"} | ${escapeMarkdown(reason)} |`),
    ...(selection.decisions.length ? [] : ["| — | Skipped | No current build definitions |"]), "",
  ].join("\n");
}

export function checkSummary(env) {
  const errors = [];
  if (env.DISCOVER_RESULT !== "success") errors.push(`discover ended ${env.DISCOVER_RESULT || "unknown"}`);
  for (const [job, required, result] of [
    ["build", env.BUILD_REQUIRED, env.BUILD_RESULT],
    ["openchamber", env.OPENCHAMBER_REQUIRED, env.OPENCHAMBER_RESULT],
  ]) {
    if (!["true", "false"].includes(required)) errors.push(`${job}: missing or invalid selection output`);
    else if (result !== (required === "true" ? "success" : "skipped")) {
      errors.push(`${job} ended ${result || "unknown"}; expected ${required === "true" ? "success" : "skipped"}`);
    }
  }
  return errors;
}

export function main(args = process.argv.slice(2), env = process.env) {
  if (args.length === 1 && args[0] === "--publication") {
    if (!["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME)) throw new Error("Publication is forbidden for this event");
    const decision = publicationDecision({ root: env.GITHUB_WORKSPACE || process.cwd(), image: env.IMAGE_NAME, ref: env.GITHUB_REF });
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `publish=${decision.publish}\n`);
    const summary = `## Publication — ${env.IMAGE_NAME}\n\n${decision.reason}\n`;
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
    console.log(summary);
    return 0;
  }
  if (args.length === 1 && args[0] === "--summary") {
    const errors = checkSummary(env);
    for (const error of errors) console.error(`::error::${error}`);
    const summary = `## Container build results\n\n${errors.length ? errors.join("\n\n") : "All selected builds succeeded; unselected jobs skipped."}\n`;
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
    return errors.length ? 1 : 0;
  }
  if (args.length) throw new Error("Usage: node .github/scripts/select-images.mjs [--summary|--publication]");
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const selection = selectImages({ root: env.GITHUB_WORKSPACE || process.cwd(), eventName: env.GITHUB_EVENT_NAME, event });
  if (selection.warning) console.warn(`::warning::${selection.warning}`);
  const outputs = `matrix=${JSON.stringify(selection.matrix)}\nbuild_required=${selection.build_required}\nopenchamber_required=${selection.openchamber_required}\n`;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, outputs);
  console.log(outputs);
  const summary = selectionSummary(selection);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

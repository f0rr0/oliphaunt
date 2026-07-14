#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

import { loadGraph } from "../../tools/release/release-graph.mjs";

function fail(message) {
  console.error(`release-drafts: ${message}`);
  process.exit(1);
}

function run(command, args, { capture = false, input } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
    input,
    stdio: capture ? ["pipe", "pipe", "pipe"] : input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
  });
  if (result.error || result.status !== 0) {
    if (capture) {
      process.stderr.write(result.stderr ?? "");
      process.stderr.write(result.stdout ?? "");
    }
    fail(result.error?.message || `${command} ${args.join(" ")} failed with status ${result.status}`);
  }
  return result.stdout?.trim() ?? "";
}

function parseArgs(argv) {
  const command = argv.shift();
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail("usage: manage-release-drafts.mjs <preflight|stage|verify|promote> --products-json JSON --head-ref SHA [--state draft|public|staged]");
    }
    values.set(key.slice(2), value);
  }
  return { command, values };
}

function api(repo, endpoint, method, body) {
  return run(
    "gh",
    ["api", `repos/${repo}/${endpoint}`, "-X", method, "--input", "-"],
    { input: `${JSON.stringify(body)}\n` },
  );
}

export function releaseNotesForVersion(changelog, version) {
  if (typeof changelog !== "string" || typeof version !== "string" || version.length === 0) {
    throw new TypeError("releaseNotesForVersion requires changelog text and a version");
  }
  const lines = changelog.split(/\r?\n/u);
  const headingIndex = lines.findIndex((line) => {
    const heading = line.match(/^##[ \t]+(?:\[)?([^\] (]+)(?:\])?(?:[ \t(]|$)/u)?.[1];
    return heading === version;
  });
  if (headingIndex === -1) {
    throw new Error(`changelog has no release heading for ${version}`);
  }
  let end = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^##[ \t]+/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  const notes = lines.slice(headingIndex + 1, end).join("\n").trim();
  return notes || `Release ${version}.`;
}

export function exactTagRefPayload(tag, headRef) {
  if (typeof tag !== "string" || tag.length === 0 || !/^[0-9a-f]{40}$/u.test(headRef)) {
    throw new TypeError("exactTagRefPayload requires a tag and a full lowercase commit SHA");
  }
  return { ref: `refs/tags/${tag}`, sha: headRef };
}

function releaseMap(repo) {
  let pages;
  try {
    pages = JSON.parse(
      run("gh", ["api", "--paginate", "--slurp", `repos/${repo}/releases?per_page=100`], { capture: true }),
    );
  } catch (error) {
    fail(`GitHub returned invalid release-list JSON: ${error.message}`);
  }
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    fail("GitHub paginated release response must be an array of pages");
  }
  const byTag = new Map();
  for (const value of pages.flat()) {
    if (typeof value?.id !== "number" || typeof value.tag_name !== "string" || typeof value.draft !== "boolean") {
      fail("GitHub returned invalid release metadata");
    }
    if (byTag.has(value.tag_name)) {
      fail(`GitHub returned duplicate releases for tag ${value.tag_name}`);
    }
    byTag.set(value.tag_name, value);
  }
  return byTag;
}

function commitForRef(ref) {
  const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    fail(result.error.message);
  }
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

async function main(argv) {
  const { command, values } = parseArgs(argv);
  if (!["preflight", "stage", "verify", "promote"].includes(command)) {
    fail("command must be preflight, stage, verify, or promote");
  }
  const repo = process.env.GITHUB_REPOSITORY?.trim();
  if (!repo || !process.env.GH_TOKEN) {
    fail("GITHUB_REPOSITORY and GH_TOKEN are required");
  }

  let products;
  try {
    products = JSON.parse(values.get("products-json") ?? "");
  } catch (error) {
    fail(`invalid --products-json: ${error.message}`);
  }
  if (!Array.isArray(products) || products.length === 0 || new Set(products).size !== products.length) {
    fail("--products-json must be a non-empty unique product string list");
  }

  const headRef = values.get("head-ref");
  if (!headRef || !/^[0-9a-f]{40}$/u.test(headRef)) {
    fail("--head-ref must be a full lowercase commit SHA");
  }
  const expectedState = values.get("state") ?? "draft";
  if (!new Set(["draft", "public", "staged"]).has(expectedState)) {
    fail("--state must be draft, public, or staged");
  }

  const graph = loadGraph("release-drafts");
  const selected = products.map((product) => {
    const config = graph.products[product];
    if (!config) {
      fail(`unknown release product ${product}`);
    }
    return {
      changelogPath: config.changelog_path,
      product,
      tag: `${config.tag_prefix}${config.version}`,
      version: config.version,
    };
  });

  run("git", ["fetch", "--force", "--tags", "origin"]);
  for (const { product, tag } of selected) {
    const target = commitForRef(tag);
    if (target !== null && target !== headRef) {
      fail(`${product} tag ${tag} targets ${target}, not ${headRef}`);
    }
    if (!["preflight", "stage"].includes(command) && target === null) {
      fail(`${product} tag ${tag} does not exist`);
    }
  }

  let releasesByTag = releaseMap(repo);
  let releases = selected.map(({ product, tag }) => ({
    product,
    tag,
    value: releasesByTag.get(tag) ?? null,
  }));
  if (command === "preflight") {
    for (const { tag, value } of releases) {
      if (value === null) {
        continue;
      }
      const tagTarget = commitForRef(tag);
      if (tagTarget === null && value.target_commitish !== headRef) {
        fail(
          `${tag} already has GitHub release ${value.id} without a tag and with ambiguous target ` +
            `${value.target_commitish ?? "<missing>"}; exact ${headRef} is required`,
        );
      }
      const releaseTarget = tagTarget ?? headRef;
      if (releaseTarget !== headRef) {
        fail(
          `${tag} already has GitHub release ${value.id} targeting ${value.target_commitish ?? "<missing>"} ` +
            `(${releaseTarget ?? "unresolved"}), not ${headRef}`,
        );
      }
    }
    console.log(`${selected.length} selected product tag/release names are absent or exact-SHA resumable`);
    return;
  }

  if (command === "stage") {
    for (const { product, tag } of selected) {
      if (commitForRef(tag) !== null) {
        continue;
      }
      api(repo, "git/refs", "POST", exactTagRefPayload(tag, headRef));
      console.log(`created exact-SHA tag ${tag} for ${product}`);
    }
    run("git", ["fetch", "--force", "--tags", "origin"]);
    for (const { product, tag } of selected) {
      const target = commitForRef(tag);
      if (target !== headRef) {
        fail(`${product} tag ${tag} resolved to ${target ?? "<missing>"} after staging, not ${headRef}`);
      }
    }
    releasesByTag = releaseMap(repo);
    for (const { changelogPath, product, tag, version } of selected) {
      if (releasesByTag.has(tag)) {
        continue;
      }
      let body;
      try {
        body = releaseNotesForVersion(readFileSync(changelogPath, "utf8"), version);
      } catch (error) {
        fail(`${product} release notes are invalid: ${error.message}`);
      }
      api(repo, "releases", "POST", {
        body,
        draft: true,
        name: `${product} v${version}`,
        prerelease: version.includes("-"),
        tag_name: tag,
        target_commitish: headRef,
      });
      console.log(`created draft GitHub release ${tag}`);
    }
    releasesByTag = releaseMap(repo);
    releases = selected.map(({ product, tag }) => ({ product, tag, value: releasesByTag.get(tag) ?? null }));
  }

  for (const { tag, value } of releases) {
    if (value === null) {
      fail(`GitHub release for ${tag} does not exist`);
    }
  }
  if (command === "promote") {
    for (const { tag, value } of releases) {
      if (!value.draft) {
        continue;
      }
      run("gh", ["api", `repos/${repo}/releases/${value.id}`, "-X", "PATCH", "-F", "draft=false"]);
      console.log(`promoted ${tag}`);
    }
    releasesByTag = releaseMap(repo);
    releases = selected.map(({ product, tag }) => ({ product, tag, value: releasesByTag.get(tag) ?? null }));
  }

  const wantDraft = command === "promote" ? false : expectedState === "draft";
  for (const { tag, value: current } of releases) {
    if (current === null) {
      fail(`GitHub release for ${tag} does not exist after ${command}`);
    }
    if (expectedState !== "staged" && current.draft !== wantDraft) {
      fail(`${tag} is ${current.draft ? "draft" : "public"}; expected ${wantDraft ? "draft" : "public"}`);
    }
  }
  if (expectedState === "staged" && command !== "promote") {
    console.log(`${selected.length} exact-SHA releases are staged (draft or already promoted by a resumable prior run)`);
  } else {
    console.log(`${selected.length} exact-SHA releases are ${wantDraft ? "draft" : "public"}`);
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}

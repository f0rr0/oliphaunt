#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const ROOT = path.resolve(import.meta.dir, "../..");

function fail(message) {
  console.error(`upload_github_release_assets.mjs: ${message}`);
  process.exit(1);
}

function usage() {
  fail("usage: upload_github_release_assets.mjs <product> [--tag TAG] [--repo OWNER/NAME] [--asset PATH]...");
}

function parseArgs(argv) {
  const args = {
    product: undefined,
    tag: undefined,
    repo: process.env.GITHUB_REPOSITORY || "",
    assets: [],
  };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--tag") {
      args.tag = valueArg(argv, index, arg);
      index += 2;
    } else if (arg === "--repo") {
      args.repo = valueArg(argv, index, arg);
      index += 2;
    } else if (arg === "--asset") {
      args.assets.push(valueArg(argv, index, arg));
      index += 2;
    } else if (arg.startsWith("--")) {
      usage();
    } else if (args.product === undefined) {
      args.product = arg;
      index += 1;
    } else {
      usage();
    }
  }
  if (!args.product) {
    usage();
  }
  return args;
}

function valueArg(argv, index, name) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    usage();
  }
  return value;
}

async function readJson(relativePath) {
  const file = path.join(ROOT, relativePath);
  let value;
  try {
    value = JSON.parse(await Bun.file(file).text());
  } catch (error) {
    fail(`could not read ${relativePath}: ${error.message}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${relativePath} must contain a JSON object`);
  }
  return value;
}

async function productPath(product) {
  const config = await readJson("release-please-config.json");
  const packages = config.packages;
  if (packages === null || typeof packages !== "object" || Array.isArray(packages)) {
    fail("release-please-config.json must define packages");
  }
  for (const [packagePath, packageConfig] of Object.entries(packages)) {
    if (
      packageConfig !== null &&
      typeof packageConfig === "object" &&
      !Array.isArray(packageConfig) &&
      packageConfig.component === product
    ) {
      if (config["include-v-in-tag"] !== true) {
        fail("release-please must include v in product tags");
      }
      if (config["tag-separator"] !== "-") {
        fail("release-please tag-separator must be '-'");
      }
      return packagePath;
    }
  }
  fail(`unknown release product ${JSON.stringify(product)}`);
}

async function defaultTag(product) {
  const manifest = await readJson(".release-please-manifest.json");
  const packagePath = await productPath(product);
  const version = manifest[packagePath];
  if (typeof version !== "string" || version.length === 0) {
    fail(`.release-please-manifest.json is missing ${packagePath}`);
  }
  return `${product}-v${version}`;
}

function runGh(args, options = {}) {
  const result = spawnSync("gh", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error !== undefined) {
    fail(`gh failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stderr);
    }
    fail(`gh ${args.join(" ")} failed with exit ${result.status}`);
  }
  return result.stdout ?? "";
}

function releaseExists(tag, repo) {
  const result = spawnSync("gh", ["release", "view", tag, "--repo", repo], {
    cwd: ROOT,
    stdio: "ignore",
  });
  if (result.error !== undefined) {
    fail(`gh failed to start: ${result.error.message}`);
  }
  return result.status === 0;
}

function ghJson(args) {
  const output = runGh([...args, "--json", "assets"], { capture: true });
  try {
    return JSON.parse(output);
  } catch (error) {
    fail(`gh ${args.join(" ")} returned malformed JSON: ${error.message}`);
  }
}

async function sha256(file) {
  const digest = createHash("sha256");
  const input = Bun.file(file).stream();
  for await (const chunk of input) {
    digest.update(chunk);
  }
  return digest.digest("hex");
}

function releaseAssetNames(tag, repo) {
  const data = ghJson(["release", "view", tag, "--repo", repo]);
  if (
    data === null ||
    typeof data !== "object" ||
    !Array.isArray(data.assets)
  ) {
    fail(`GitHub release ${tag} returned malformed asset metadata`);
  }
  return new Set(
    data.assets
      .filter((asset) => asset !== null && typeof asset === "object" && typeof asset.name === "string")
      .map((asset) => asset.name),
  );
}

function downloadReleaseAsset(tag, repo, assetName, destination) {
  runGh(["release", "download", tag, "--pattern", assetName, "--dir", destination, "--repo", repo]);
  const file = path.join(destination, assetName);
  if (!existsSync(file)) {
    fail(`failed to download existing GitHub release asset ${assetName}`);
  }
  return file;
}

async function resolveAsset(asset) {
  const relative = path.join(ROOT, asset);
  if ((await isFile(relative))) {
    return relative;
  }
  const direct = path.resolve(asset);
  if ((await isFile(direct))) {
    return direct;
  }
  fail(`release asset does not exist: ${asset}`);
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function uploadReleaseAssets(product, tag, repo, assets) {
  if (!releaseExists(tag, repo)) {
    fail(
      `${product} GitHub release ${tag} does not exist. ` +
        "Run release-please before package-native publish steps.",
    );
  }

  if (assets.length === 0) {
    console.log(`${product} GitHub release ${tag} exists; no assets to upload.`);
    return;
  }

  const seenNames = new Set();
  const uploadAssets = [];
  const existingNames = releaseAssetNames(tag, repo);
  const tmp = mkdtempSync(path.join(tmpdir(), "oliphaunt-release-assets-"));
  try {
    for (const asset of assets) {
      const assetPath = await resolveAsset(asset);
      const assetName = path.basename(assetPath);
      if (seenNames.has(assetName)) {
        fail(`duplicate release asset name in upload set: ${assetName}`);
      }
      seenNames.add(assetName);
      if (!existingNames.has(assetName)) {
        uploadAssets.push(asset);
        continue;
      }
      const existing = downloadReleaseAsset(tag, repo, assetName, tmp);
      const [localSha, remoteSha] = await Promise.all([sha256(assetPath), sha256(existing)]);
      if (localSha === remoteSha) {
        console.log(`${product} GitHub release ${tag} already has identical asset ${assetName}; skipping.`);
        continue;
      }
      fail(
        `${product} GitHub release ${tag} already has different bytes for ${assetName}; ` +
          "delete the conflicting GitHub release asset manually before rerunning an intentional repair",
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (uploadAssets.length > 0) {
    runGh(["release", "upload", tag, ...uploadAssets, "--repo", repo]);
  } else {
    console.log(`${product} GitHub release ${tag} already has all requested assets with matching checksums.`);
  }
}

const args = parseArgs(Bun.argv.slice(2));
if (!args.repo) {
  fail("--repo or GITHUB_REPOSITORY is required");
}
const tag = args.tag || (await defaultTag(args.product));
for (const asset of args.assets) {
  await resolveAsset(asset);
}
await uploadReleaseAssets(args.product, tag, args.repo, args.assets);

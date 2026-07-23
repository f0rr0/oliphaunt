#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const TOOL = "prepare-swift-release-consumer.mjs";
const LOCAL_XCFRAMEWORK_PATH = "Artifacts/liboliphaunt.xcframework";
const BINARY_TARGET = /\.binaryTarget\(\s*name:\s*"liboliphaunt"\s*,\s*url:\s*"([^"]+)"\s*,\s*checksum:\s*"([0-9a-f]{64})"\s*\)/gmu;

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function releaseAssetIdentity(assetFile) {
  const basename = path.basename(assetFile);
  const match = /^liboliphaunt-(.+)-apple-spm-xcframework\.zip$/u.exec(basename);
  if (!match || !match[1]) {
    throw new Error(
      `Apple XCFramework asset must be named liboliphaunt-<version>-apple-spm-xcframework.zip: ${basename}`,
    );
  }
  return { basename, version: match[1] };
}

export function parseSwiftReleaseBinaryTarget(
  manifest,
  label = "release manifest",
) {
  if (typeof manifest !== "string") {
    throw new Error(`${label} must be text`);
  }
  const matches = [...manifest.matchAll(BINARY_TARGET)];
  if (matches.length !== 1) {
    throw new Error(
      `${label} must contain exactly one checksum-pinned liboliphaunt binary target; found ${matches.length}`,
    );
  }
  const [match] = matches;
  return {
    checksum: match[2],
    end: match.index + match[0].length,
    index: match.index,
    url: match[1],
  };
}

export function localizeSwiftReleaseManifest({ manifestFile, assetFile, outputFile }) {
  const manifest = readFileSync(manifestFile, "utf8");
  const { checksum, end, index, url } = parseSwiftReleaseBinaryTarget(manifest);
  const { basename, version } = releaseAssetIdentity(assetFile);
  const expectedUrl =
    `https://github.com/f0rr0/oliphaunt/releases/download/` +
    `liboliphaunt-native-v${version}/${basename}`;
  if (url !== expectedUrl) {
    throw new Error(
      `release manifest binary URL is not the canonical ${expectedUrl}: ${url}`,
    );
  }
  const actualChecksum = sha256(assetFile);
  if (checksum !== actualChecksum) {
    throw new Error(
      `release manifest checksum ${checksum} does not match ${basename} SHA-256 ${actualChecksum}`,
    );
  }

  const replacement = `.binaryTarget(\n` +
    `            name: "liboliphaunt",\n` +
    `            path: "${LOCAL_XCFRAMEWORK_PATH}"\n` +
    `        )`;
  const localized = manifest.slice(0, index) + replacement + manifest.slice(end);
  if (localized.includes("file://")) {
    throw new Error("localized release manifest must not contain a file URL");
  }
  if (!localized.includes(`path: "${LOCAL_XCFRAMEWORK_PATH}"`)) {
    throw new Error("localized release manifest did not retain the exact local XCFramework projection");
  }
  mkdirSync(path.dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, localized, "utf8");
  return {
    asset: basename,
    checksum: actualChecksum,
    publicUrl: expectedUrl,
    xcframeworkPath: LOCAL_XCFRAMEWORK_PATH,
  };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--manifest", "--asset", "--output"].includes(key)) {
      throw new Error(`unknown argument ${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${key} requires a value`);
    }
    if (values.has(key)) {
      throw new Error(`${key} may be specified only once`);
    }
    values.set(key, value);
    index += 1;
  }
  for (const key of ["--manifest", "--asset", "--output"]) {
    if (!values.has(key)) {
      throw new Error(`${key} is required`);
    }
  }
  return {
    assetFile: path.resolve(values.get("--asset")),
    manifestFile: path.resolve(values.get("--manifest")),
    outputFile: path.resolve(values.get("--output")),
  };
}

if (import.meta.main) {
  try {
    const result = localizeSwiftReleaseManifest(parseArgs(Bun.argv.slice(2)));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`${TOOL}: ${error.message}`);
    process.exit(1);
  }
}

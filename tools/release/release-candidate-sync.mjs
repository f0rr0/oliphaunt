import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const VERSION_IN_MARKER = /(?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)/gu;
const TOML_TABLE = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function error(prefix, message) {
  return new Error(`${prefix}: ${message}`);
}

function object(value, context, prefix) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw error(prefix, `${context} must be an object`);
  }
  return value;
}

function packageRelative(packagePath, relativePath, context, prefix) {
  if (
    typeof packagePath !== "string" || packagePath.length === 0 || path.posix.isAbsolute(packagePath) ||
    typeof relativePath !== "string" || relativePath.length === 0 || path.posix.isAbsolute(relativePath)
  ) {
    throw error(prefix, `${context} must use non-empty relative package paths`);
  }
  const packageRoot = path.posix.normalize(packagePath.replaceAll("\\", "/"));
  const file = path.posix.normalize(path.posix.join(packageRoot, relativePath.replaceAll("\\", "/")));
  if (file !== packageRoot && !file.startsWith(`${packageRoot}/`)) {
    throw error(prefix, `${context} must stay inside ${packageRoot}`);
  }
  return file;
}

function jsonPathParts(expression, context, prefix) {
  if (typeof expression !== "string" || !/^[$][.][A-Za-z0-9_.-]+$/u.test(expression)) {
    throw error(prefix, `${context} must use a simple $.path JSONPath`);
  }
  return expression.slice(2).split(".");
}

function packageDescriptors(product, graphProduct, packagePath, config, prefix) {
  const releaseType = config["release-type"];
  const versionFile = config["version-file"];
  let canonical;
  if (typeof versionFile === "string" && versionFile.length > 0) {
    canonical = { path: packageRelative(packagePath, versionFile, `${product}.version-file`, prefix), type: "raw" };
  } else if (releaseType === "rust") {
    canonical = {
      path: packageRelative(packagePath, "Cargo.toml", `${product}.Cargo.toml`, prefix),
      type: "toml",
      parts: ["package", "version"],
    };
  } else if (releaseType === "node" || releaseType === "expo") {
    canonical = {
      path: packageRelative(packagePath, "package.json", `${product}.package.json`, prefix),
      type: "json",
      parts: ["version"],
    };
  } else {
    throw error(prefix, `${product} has no supported canonical version file declaration`);
  }

  const rawExtraFiles = config["extra-files"] ?? [];
  if (!Array.isArray(rawExtraFiles)) {
    throw error(prefix, `${product}.extra-files must be a list`);
  }
  const extra = rawExtraFiles.map((entry, index) => {
    const context = `${product}.extra-files[${index}]`;
    if (typeof entry === "string") {
      return { path: packageRelative(packagePath, entry, context, prefix), type: "generic" };
    }
    object(entry, context, prefix);
    const type = entry.type ?? "generic";
    if (!["generic", "json", "toml"].includes(type)) {
      throw error(prefix, `${context}.type ${JSON.stringify(type)} is unsupported`);
    }
    return {
      path: packageRelative(packagePath, entry.path, `${context}.path`, prefix),
      type,
      ...((type === "json" || type === "toml")
        ? { parts: jsonPathParts(entry.jsonpath, `${context}.jsonpath`, prefix) }
        : {}),
    };
  });
  const descriptors = [canonical, ...extra];
  const paths = descriptors.map((descriptor) => descriptor.path);
  if (new Set(paths).size !== paths.length) {
    throw error(prefix, `${product} release-please version files must not contain duplicates`);
  }
  const graphPaths = graphProduct.version_files;
  if (!Array.isArray(graphPaths) || graphPaths.some((file) => typeof file !== "string")) {
    throw error(prefix, `${product}.version_files must be a string list`);
  }
  if (
    JSON.stringify([...paths].sort(compareText)) !==
    JSON.stringify([...graphPaths].sort(compareText))
  ) {
    throw error(
      prefix,
      `${product} graph version files must exactly match release-please declarations: ` +
        `graph=${JSON.stringify([...graphPaths].sort(compareText))} ` +
        `releasePlease=${JSON.stringify([...paths].sort(compareText))}`,
    );
  }
  return descriptors;
}

function replaceRaw(text, before, after, context, prefix) {
  if (text.trim() !== before) {
    throw error(prefix, `${context} contains ${JSON.stringify(text.trim())}, expected ${before}`);
  }
  const index = text.indexOf(before);
  if (index < 0 || text.indexOf(before, index + before.length) >= 0) {
    throw error(prefix, `${context} must contain its current version exactly once`);
  }
  return `${text.slice(0, index)}${after}${text.slice(index + before.length)}`;
}

function setObjectPath(value, parts, before, after, context, prefix) {
  let cursor = object(value, context, prefix);
  for (const part of parts.slice(0, -1)) {
    if (!(part in cursor)) throw error(prefix, `${context} is missing path ${parts.join(".")}`);
    cursor = object(cursor[part], `${context}.${part}`, prefix);
  }
  const key = parts.at(-1);
  if (cursor[key] !== before) {
    throw error(prefix, `${context}.${parts.join(".")} contains ${JSON.stringify(cursor[key])}, expected ${before}`);
  }
  cursor[key] = after;
}

function replaceJson(text, parts, before, after, context, prefix) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw error(prefix, `${context} is invalid JSON: ${cause.message}`);
  }
  setObjectPath(value, parts, before, after, context, prefix);
  return `${JSON.stringify(value, null, 2)}\n`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function replaceToml(text, parts, before, after, context, prefix) {
  if (parts.length < 2) {
    throw error(prefix, `${context} TOML path must include a table and key`);
  }
  const table = parts.slice(0, -1).join(".");
  const key = parts.at(-1);
  const pattern = new RegExp(
    `^(\\s*${escapeRegExp(key)}\\s*=\\s*)(["'])${escapeRegExp(before)}\\2(\\s*(?:#.*)?)$`,
    "u",
  );
  const lines = text.split(/(?<=\n)/u);
  let currentTable = "";
  let matched = 0;
  for (const [index, line] of lines.entries()) {
    const newline = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
    const body = line.slice(0, line.length - newline.length);
    const tableMatch = TOML_TABLE.exec(body);
    if (tableMatch !== null) {
      currentTable = tableMatch[1].trim();
      continue;
    }
    if (currentTable !== table) continue;
    const match = pattern.exec(body);
    if (match === null) {
      if (new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`, "u").test(body)) {
        throw error(prefix, `${context}.${parts.join(".")} does not equal ${before}`);
      }
      continue;
    }
    matched += 1;
    lines[index] = `${match[1]}${match[2]}${after}${match[2]}${match[3]}${newline}`;
  }
  if (matched !== 1) {
    throw error(prefix, `${context} must contain exactly one TOML string at ${parts.join(".")}`);
  }
  return lines.join("");
}

function replaceGeneric(text, before, after, context, prefix) {
  const markedLines = text.split(/\r?\n/u).filter((line) => line.includes("x-release-please-version"));
  if (markedLines.length === 1) {
    const versions = markedLines[0].match(VERSION_IN_MARKER) ?? [];
    if (versions.length !== 1 || versions[0] !== before) {
      throw error(prefix, `${context} version marker must own exactly the current version ${before}`);
    }
    return text.replace(markedLines[0], markedLines[0].replace(before, after));
  }
  const blockMatch = /x-release-please-start-version(?<body>[\s\S]*?)x-release-please-end/u.exec(text);
  const body = blockMatch?.groups?.body;
  const versions = body?.match(VERSION_IN_MARKER) ?? [];
  if (markedLines.length !== 0 || body === undefined || versions.length !== 1 || versions[0] !== before) {
    throw error(prefix, `${context} must have one Release Please marker or marker block owning ${before}`);
  }
  return text.replace(body, body.replace(before, after));
}

function changelogHeadingVersion(line) {
  return line.match(/^##[ \t]+(?:\[)?([^\] (]+)(?:\])?(?:[ \t(]|$)/u)?.[1];
}

function reasonText(reason) {
  if (reason.kind === "shared-source") {
    return `shared contrib carrier source: ${reason.summary} (${reason.commit.slice(0, 8)})`;
  }
  throw error("release-candidate-sync", `unsupported release reason ${reason.kind}`);
}

function changelogContent(candidate) {
  const sharedSource = candidate.reasons.every((reason) => reason.kind === "shared-source");
  const section = sharedSource ? (candidate.changelogSection ?? "Bug Fixes") : "Dependencies";
  const label = sharedSource ? "contrib" : "dependencies";
  const bullets = candidate.reasons.map((reason) => `* **${label}:** ${reasonText(reason)}`);
  return { bullets, section };
}

function updateChangelog(text, candidate, context, prefix) {
  const lines = text.split(/\r?\n/u);
  if (lines.some((line) => changelogHeadingVersion(line) === candidate.after)) {
    throw error(prefix, `${context} already contains release heading ${candidate.after}`);
  }
  if (!lines.some((line) => changelogHeadingVersion(line) === candidate.before)) {
    throw error(
      prefix,
      `${context} has no prior release heading for ${candidate.before}; candidate synchronization is post-first-release only`,
    );
  }
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const { bullets, section } = changelogContent(candidate);
  const entry = [`## ${candidate.after}`, "", `### ${section}`, "", ...bullets].join(newline);
  const heading = /^# [^\r\n]+(?:\r?\n|$)/u.exec(text);
  if (heading === null) {
    return `${entry}${newline}${newline}${text}`;
  }
  const remainder = text.slice(heading[0].length).replace(/^(?:\r?\n)*/u, "");
  return `${heading[0]}${newline}${entry}${newline}${newline}${remainder}`;
}

function mergeExistingChangelog(text, candidate, context, prefix) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/u);
  const releaseHeadings = lines
    .map((line, index) => ({ index, version: changelogHeadingVersion(line) }))
    .filter(({ version }) => version !== undefined);
  const matches = releaseHeadings.filter(({ version }) => version === candidate.before);
  if (matches.length !== 1) {
    throw error(prefix, `${context} must contain exactly one release heading for ${candidate.before}`);
  }
  if (
    candidate.before !== candidate.after
    && releaseHeadings.some(({ version }) => version === candidate.after)
  ) {
    throw error(prefix, `${context} already contains release heading ${candidate.after}`);
  }

  const releaseStart = matches[0].index;
  const releaseEnd = releaseHeadings.find(({ index }) => index > releaseStart)?.index ?? lines.length;
  if (candidate.before !== candidate.after) {
    lines[releaseStart] = lines[releaseStart].replaceAll(candidate.before, candidate.after);
  }

  const { bullets, section } = changelogContent(candidate);
  const releaseLines = lines.slice(releaseStart, releaseEnd);
  const missingBullets = bullets.filter((bullet) => !releaseLines.includes(bullet));
  if (missingBullets.length === 0) return lines.join(newline);

  const sectionHeading = `### ${section}`;
  const sectionMatches = lines
    .slice(releaseStart + 1, releaseEnd)
    .map((line, index) => ({ index: releaseStart + index + 1, line }))
    .filter(({ line }) => line === sectionHeading);
  if (sectionMatches.length > 1) {
    throw error(prefix, `${context} release ${candidate.before} contains duplicate ${sectionHeading} sections`);
  }
  if (sectionMatches.length === 1) {
    let insertAt = sectionMatches[0].index + 1;
    while (insertAt < releaseEnd && lines[insertAt] === "") insertAt += 1;
    lines.splice(insertAt, 0, ...missingBullets);
    return lines.join(newline);
  }

  let insertAt = releaseEnd;
  while (insertAt > releaseStart + 1 && lines[insertAt - 1] === "") insertAt -= 1;
  lines.splice(insertAt, 0, "", sectionHeading, "", ...missingBullets);
  return lines.join(newline);
}

function stageFileIfChanged(root, relativePath, updated, detail, changes, prefix) {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(root, relativePath);
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw error(prefix, `${relativePath} escapes the repository root`);
  }
  if (!existsSync(absolute)) throw error(prefix, `missing ${relativePath}`);
  const before = readFileSync(absolute, "utf8");
  const next = updated(before);
  if (next === before) return false;
  changes.push({ path: absolute, detail, text: next });
  return true;
}

function stageFile(root, relativePath, updated, detail, changes, prefix) {
  if (!stageFileIfChanged(root, relativePath, updated, detail, changes, prefix)) {
    throw error(prefix, `${relativePath} did not change while applying ${detail}`);
  }
}

function packagesByProduct(releasePleaseConfig, prefix) {
  const packages = object(releasePleaseConfig?.packages, "release-please packages", prefix);
  const byProduct = new Map();
  for (const [packagePath, packageConfig] of Object.entries(packages).sort(([left], [right]) => compareText(left, right))) {
    object(packageConfig, `release-please package ${packagePath}`, prefix);
    const product = packageConfig.component;
    if (typeof product !== "string" || product.length === 0 || byProduct.has(product)) {
      throw error(prefix, `release-please package ${packagePath} has a missing or duplicate component`);
    }
    byProduct.set(product, { packagePath, packageConfig });
  }
  return byProduct;
}

/**
 * Apply (or report in check mode) candidate manifest, version-file, extra-file,
 * and changelog updates using only the declarations Release Please already owns.
 */
export function synchronizeReleaseCandidates({
  root,
  graph,
  candidates,
  releasePleaseConfig,
  manifest,
  write = false,
  prefix = "release-candidate-sync",
}) {
  if (typeof root !== "string" || root.length === 0) throw error(prefix, "root must be a path");
  if (!Array.isArray(candidates)) throw error(prefix, "release candidates must be a list");
  const manifestObject = object(manifest, ".release-please-manifest.json", prefix);
  const packages = packagesByProduct(releasePleaseConfig, prefix);
  const changes = [];
  if (candidates.length === 0) return changes;

  const nextManifest = { ...manifestObject };
  const manifestDetails = [];
  for (const candidate of candidates) {
    const mergeExisting = candidate.changelogMode === "merge-existing";
    if (candidate.changelogMode !== undefined && !mergeExisting) {
      throw error(
        prefix,
        `${candidate.product} has unsupported changelog mode ${JSON.stringify(candidate.changelogMode)}`,
      );
    }
    if (candidate.before === candidate.after && !mergeExisting) {
      throw error(prefix, `${candidate.product} release candidate does not advance from ${candidate.before}`);
    }
    const packageInfo = packages.get(candidate.product);
    if (packageInfo === undefined) {
      throw error(prefix, `${candidate.product} is missing from release-please-config.json`);
    }
    const { packagePath, packageConfig } = packageInfo;
    if (packagePath !== candidate.packagePath) {
      throw error(
        prefix,
        `${candidate.product} graph path ${JSON.stringify(candidate.packagePath)} does not match ` +
          `release-please path ${JSON.stringify(packagePath)}`,
      );
    }
    if (nextManifest[packagePath] !== candidate.before) {
      throw error(
        prefix,
        `${candidate.product} manifest contains ${JSON.stringify(nextManifest[packagePath])}, expected ${candidate.before}`,
      );
    }
    if (candidate.before !== candidate.after) {
      nextManifest[packagePath] = candidate.after;
      manifestDetails.push(`${candidate.product} ${candidate.before} -> ${candidate.after}`);

      const descriptors = packageDescriptors(
        candidate.product,
        graph.products[candidate.product],
        packagePath,
        packageConfig,
        prefix,
      );
      for (const descriptor of descriptors) {
        const detail = `${candidate.product} release candidate ${candidate.before} -> ${candidate.after}`;
        stageFile(
          root,
          descriptor.path,
          (text) => {
            if (descriptor.type === "raw") {
              return replaceRaw(text, candidate.before, candidate.after, descriptor.path, prefix);
            }
            if (descriptor.type === "json") {
              return replaceJson(text, descriptor.parts, candidate.before, candidate.after, descriptor.path, prefix);
            }
            if (descriptor.type === "toml") {
              return replaceToml(text, descriptor.parts, candidate.before, candidate.after, descriptor.path, prefix);
            }
            return replaceGeneric(text, candidate.before, candidate.after, descriptor.path, prefix);
          },
          detail,
          changes,
          prefix,
        );
      }
    }

    const changelog = packageRelative(
      packagePath,
      packageConfig["changelog-path"] ?? "CHANGELOG.md",
      `${candidate.product}.changelog-path`,
      prefix,
    );
    if (graph.products[candidate.product].changelog_path !== changelog) {
      throw error(
        prefix,
        `${candidate.product} graph changelog ${JSON.stringify(graph.products[candidate.product].changelog_path)} ` +
          `does not match release-please changelog ${JSON.stringify(changelog)}`,
      );
    }
    const update = mergeExisting
      ? (text) => mergeExistingChangelog(text, candidate, changelog, prefix)
      : (text) => updateChangelog(text, candidate, changelog, prefix);
    const detail = `${candidate.product} ${mergeExisting ? "shared-source" : "dependency-only"} changelog ` +
      `for ${candidate.after}`;
    if (mergeExisting) {
      stageFileIfChanged(root, changelog, update, detail, changes, prefix);
    } else {
      stageFile(root, changelog, update, detail, changes, prefix);
    }
  }

  if (manifestDetails.length > 0) {
    stageFile(
      root,
      ".release-please-manifest.json",
      () => `${JSON.stringify(nextManifest, null, 2)}\n`,
      manifestDetails.join("; "),
      changes,
      prefix,
    );
  }
  const duplicatePaths = changes
    .map(({ path: file }) => file)
    .filter((file, index, files) => files.indexOf(file) !== index);
  if (duplicatePaths.length > 0) {
    throw error(prefix, `release candidate outputs overlap: ${[...new Set(duplicatePaths)].join(", ")}`);
  }
  if (write) {
    for (const change of changes) writeFileSync(change.path, change.text, "utf8");
  }
  return changes.map(({ path: file, detail }) => ({ path: file, detail }));
}

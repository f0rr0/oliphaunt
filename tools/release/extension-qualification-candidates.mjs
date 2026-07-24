#!/usr/bin/env bun

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const TOOL = "extension-qualification-candidates.mjs";
const DEFAULT_ROOT = path.resolve(import.meta.dir, "../..");
const CANDIDATE_SCHEMA = "oliphaunt-extension-qualification-candidate-v1";
const PROFILE_SCHEMA = "oliphaunt-extension-artifact-target-profiles-v1";
const SAFE_ID = /^[a-z][a-z0-9_]*$/u;
const SAFE_SQL_NAME = /^[a-z][a-z0-9_-]*$/u;
const SAFE_TARGET = /^[A-Za-z0-9._-]+$/u;
const FULL_GIT_SHA = /^[0-9a-f]{40}$/u;

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function readRegularText(root, file, label = relative(root, file)) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (cause) {
    fail(`${label} cannot be inspected: ${cause.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label} must be a regular non-symlink file`);
  }
  return readFileSync(file, "utf8");
}

function readToml(root, file, label = relative(root, file)) {
  try {
    return Bun.TOML.parse(readRegularText(root, file, label));
  } catch (cause) {
    fail(`${label} is not valid TOML: ${cause.message}`);
  }
}

function readJson(root, file, label = relative(root, file)) {
  try {
    return JSON.parse(readRegularText(root, file, label));
  } catch (cause) {
    fail(`${label} is not valid JSON: ${cause.message}`);
  }
}

function nonEmptyString(value, label, pattern = undefined) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    fail(`${label} must be a non-empty trimmed string`);
  }
  if (pattern !== undefined && !pattern.test(value)) {
    fail(`${label} has invalid value ${JSON.stringify(value)}`);
  }
  return value;
}

function exactStringList(value, label, { pattern = undefined } = {}) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label} must be a non-empty string list`);
  }
  const items = value.map((item, index) => nonEmptyString(item, `${label}[${index}]`, pattern));
  const canonical = [...new Set(items)].sort(compareText);
  if (JSON.stringify(items) !== JSON.stringify(canonical)) {
    fail(`${label} must be sorted and unique`);
  }
  return items;
}

function promotionRows(root) {
  const file = path.join(root, "src/extensions/catalog/extensions.promoted.toml");
  const data = readToml(root, file);
  if (!Array.isArray(data.extensions)) {
    fail(`${relative(root, file)} must define [[extensions]] rows`);
  }
  const rows = new Map();
  for (const row of data.extensions) {
    const id = nonEmptyString(row?.id, `${relative(root, file)} extension id`, SAFE_ID);
    if (rows.has(id)) fail(`${relative(root, file)} repeats extension ${id}`);
    rows.set(id, row);
  }
  return rows;
}

function targetProfiles(root) {
  const file = path.join(root, "tools/release/extension-target-profiles.toml");
  const data = readToml(root, file);
  if (data.schema !== PROFILE_SCHEMA || !Array.isArray(data.profiles)) {
    fail(`${relative(root, file)} must use schema ${PROFILE_SCHEMA} and define [[profiles]]`);
  }
  const profiles = new Map();
  for (const row of data.profiles) {
    const id = nonEmptyString(row?.id, `${relative(root, file)} profile id`, SAFE_TARGET);
    if (profiles.has(id)) fail(`${relative(root, file)} repeats profile ${id}`);
    if (!Array.isArray(row.targets) || row.targets.length === 0) {
      fail(`${relative(root, file)} profile ${id} must define target rows`);
    }
    const targets = row.targets.map((targetRow, index) => Object.freeze({
      family: nonEmptyString(targetRow?.family, `${id} target[${index}] family`, SAFE_TARGET),
      kind: nonEmptyString(targetRow?.kind, `${id} target[${index}] kind`, SAFE_TARGET),
      target: nonEmptyString(targetRow?.target, `${id} target[${index}] target`, SAFE_TARGET),
    }));
    const keys = targets.map(({ family, kind, target }) => `${family}\0${target}\0${kind}`);
    if (new Set(keys).size !== keys.length) fail(`${relative(root, file)} profile ${id} repeats a target row`);
    profiles.set(id, Object.freeze(targets));
  }
  return profiles;
}

function sourceCatalogRows(root) {
  const file = path.join(root, "src/extensions/catalog/extensions.source.json");
  if (!existsSync(file)) return new Map();
  const data = readJson(root, file);
  if (!Array.isArray(data.extensions)) fail(`${relative(root, file)} must define extensions`);
  const rows = new Map();
  for (const row of data.extensions) {
    if (typeof row?.id === "string") rows.set(row.id, row);
  }
  return rows;
}

export function extensionQualificationCandidates({ root = DEFAULT_ROOT } = {}) {
  const externalRoot = path.join(root, "src/extensions/external");
  const promotions = promotionRows(root);
  const profiles = targetProfiles(root);
  const sourceRows = sourceCatalogRows(root);
  const candidates = [];

  for (const entry of readdirSync(externalRoot, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))) {
    if (!entry.isDirectory()) continue;
    const extensionRoot = path.join(externalRoot, entry.name);
    if (!existsSync(path.join(extensionRoot, "publication-blocker.toml"))) continue;

    const extensionId = nonEmptyString(entry.name, "deferred extension directory", SAFE_ID);
    const promotion = promotions.get(extensionId);
    if (promotion === undefined) fail(`${extensionId} has a publication blocker but no promotion row`);
    if (promotion.build !== true || promotion.stable !== false) {
      fail(`${extensionId} publication-deferred qualification requires build = true and stable = false`);
    }
    const blocker = nonEmptyString(promotion.blocker, `${extensionId} promotion blocker`);
    if (blocker.length < 40) fail(`${extensionId} promotion blocker must be specific and actionable`);

    const recipeFile = path.join(extensionRoot, "recipe.toml");
    const sourceFile = path.join(extensionRoot, "source.toml");
    const targetsFile = path.join(extensionRoot, "targets/artifacts.toml");
    const recipe = readToml(root, recipeFile);
    const source = readToml(root, sourceFile);
    const targets = readToml(root, targetsFile);
    const sqlName = nonEmptyString(recipe.sql_name, `${relative(root, recipeFile)} sql_name`, SAFE_SQL_NAME);
    const sourceName = nonEmptyString(source.name, `${relative(root, sourceFile)} name`, SAFE_SQL_NAME);
    const recipeSource = nonEmptyString(recipe.source, `${relative(root, recipeFile)} source`, SAFE_SQL_NAME);
    if (sourceName !== recipeSource) {
      fail(`${relative(root, recipeFile)} source must match ${relative(root, sourceFile)} name`);
    }
    const control = source["extension-control"];
    if (control === null || typeof control !== "object" || Array.isArray(control)) {
      fail(`${relative(root, sourceFile)} must define [extension-control]`);
    }
    if (control["sql-name"] !== sqlName) {
      fail(`${relative(root, sourceFile)} extension-control.sql-name must equal recipe sql_name ${sqlName}`);
    }
    const sourceVersion = nonEmptyString(
      control["default-version"],
      `${relative(root, sourceFile)} extension-control.default-version`,
      /^[0-9A-Za-z][0-9A-Za-z._-]*$/u,
    );
    const sourceCommit = nonEmptyString(source.commit, `${relative(root, sourceFile)} commit`, FULL_GIT_SHA);
    if (targets.schema !== "oliphaunt-extension-artifact-targets-v1") {
      fail(`${relative(root, targetsFile)} must use schema oliphaunt-extension-artifact-targets-v1`);
    }
    const selectedProfiles = exactStringList(targets.profiles, `${relative(root, targetsFile)} profiles`, {
      pattern: SAFE_TARGET,
    });
    for (const profile of selectedProfiles) {
      if (!profiles.has(profile)) fail(`${relative(root, targetsFile)} selects unknown profile ${profile}`);
    }

    const sourceRow = sourceRows.get(extensionId);
    if (sourceRow !== undefined && sourceRow["sql-name"] !== sqlName) {
      fail(`source catalog ${extensionId} sql-name does not match ${sqlName}`);
    }
    candidates.push(Object.freeze({
      schema: CANDIDATE_SCHEMA,
      extensionId,
      sqlName,
      sourceName,
      sourceVersion,
      sourceCommit,
      requested: true,
      stable: false,
      blocker,
      targetProfiles: Object.freeze([...selectedProfiles]),
    }));
  }
  candidates.sort((left, right) => compareText(left.sqlName, right.sqlName));
  return Object.freeze(candidates);
}

export function qualificationCandidateTargets(candidate, { root = DEFAULT_ROOT } = {}) {
  const profiles = targetProfiles(root);
  const rows = candidate.targetProfiles.flatMap((profile) => profiles.get(profile) ?? []);
  const byKey = new Map();
  for (const row of rows) byKey.set(`${row.family}\0${row.target}\0${row.kind}`, row);
  return Object.freeze([...byKey.values()].sort(
    (left, right) => compareText(left.family, right.family)
      || compareText(left.target, right.target)
      || compareText(left.kind, right.kind),
  ));
}

export function qualificationCandidateSqlNamesForTarget(target, { family = undefined, root = DEFAULT_ROOT } = {}) {
  nonEmptyString(target, "qualification target", SAFE_TARGET);
  const names = [];
  for (const candidate of extensionQualificationCandidates({ root })) {
    const matches = qualificationCandidateTargets(candidate, { root }).some(
      (row) => row.target === target && (family === undefined || row.family === family),
    );
    if (matches) names.push(candidate.sqlName);
  }
  return Object.freeze([...new Set(names)].sort(compareText));
}

function parseArgs(argv) {
  let target;
  let family;
  let format = "json";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target") target = argv[++index];
    else if (arg === "--family") family = argv[++index];
    else if (arg === "--format") format = argv[++index];
    else fail(`unknown argument ${arg}`);
  }
  if (!new Set(["json", "csv"]).has(format)) fail("--format must be json or csv");
  if (family !== undefined && target === undefined) fail("--family requires --target");
  return { target, family, format };
}

if (import.meta.main) {
  try {
    const options = parseArgs(Bun.argv.slice(2));
    const value = options.target === undefined
      ? extensionQualificationCandidates()
      : qualificationCandidateSqlNamesForTarget(options.target, { family: options.family });
    console.log(options.format === "csv" ? value.join(",") : JSON.stringify(value, null, 2));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}

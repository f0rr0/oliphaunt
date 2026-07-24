#!/usr/bin/env bun

const EXPECTED_PRODUCTS = [
  'oliphaunt-rust',
  'oliphaunt-swift',
  'oliphaunt-kotlin',
  'oliphaunt-js',
  'oliphaunt-react-native',
  'oliphaunt-wasix-rust',
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function numberValue(value) {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return Number(value);
  }
  return Number.NaN;
}

function requireString(value, context) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${context} must be a non-empty string`);
  }
}

const selected = process.argv[2] ?? 'all';
const targets = selected === 'all' ? EXPECTED_PRODUCTS : [selected];
const baseline = Bun.TOML.parse(await Bun.file('coverage/baseline.toml').text());
const products = baseline.products ?? {};

for (const product of targets) {
  const config = products[product];
  if (config === undefined || config === null || typeof config !== 'object') {
    fail(`missing coverage product config: ${product}`);
  }
  if ('include_globs' in config) {
    fail(`${product}: coverage must use source_globs, not include_globs`);
  }
  const sourceGlobs = config.source_globs;
  if (
    !Array.isArray(sourceGlobs) ||
    sourceGlobs.length === 0 ||
    !sourceGlobs.every((item) => typeof item === 'string')
  ) {
    fail(`${product}: source_globs must be a non-empty string array`);
  }
  const lineThreshold = numberValue(config.line_threshold);
  if (Number.isNaN(lineThreshold) || lineThreshold < 80.0) {
    fail(`${product}: aggregate line_threshold must stay at or above 80`);
  }
  const perFileLineThreshold = numberValue(config.per_file_line_threshold);
  if (Number.isNaN(perFileLineThreshold) || perFileLineThreshold < 50.0) {
    fail(`${product}: per_file_line_threshold must stay at or above 50`);
  }
  const measuredLineCoverage = numberValue(config.measured_line_coverage);
  if (Number.isNaN(measuredLineCoverage) || measuredLineCoverage < lineThreshold) {
    fail(`${product}: measured_line_coverage audit snapshot is below the aggregate threshold`);
  }
  const waivers = config.waivers;
  if (!Array.isArray(waivers) || waivers.length === 0) {
    fail(`${product}: coverage waivers must be explicit even when the list is short`);
  }
  for (const waiver of waivers) {
    if (waiver === null || typeof waiver !== 'object' || Array.isArray(waiver)) {
      fail(`${product}: waiver must be a TOML table`);
    }
    const hasPath = typeof waiver.path === 'string';
    const hasGlob = typeof waiver.glob === 'string';
    if (hasPath === hasGlob) {
      fail(`${product}: waiver must define exactly one of path or glob`);
    }
    for (const key of ['reason', 'evidence', 'owner', 'expires']) {
      requireString(waiver[key], `${product}: waiver ${key}`);
    }
  }
}

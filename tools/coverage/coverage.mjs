#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  accessSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { captureCommandOutput } from '../dev/capture-command-output.mjs';

const PRODUCTS = [
  'oliphaunt-rust',
  'oliphaunt-swift',
  'oliphaunt-kotlin',
  'oliphaunt-js',
  'oliphaunt-react-native',
  'oliphaunt-wasix-rust',
];

const PRODUCT_SOURCE_ROOTS = new Map([
  ['oliphaunt-rust', 'src/sdks/rust'],
  ['oliphaunt-swift', 'src/sdks/swift'],
  ['oliphaunt-kotlin', 'src/sdks/kotlin'],
  ['oliphaunt-js', 'src/sdks/js'],
  ['oliphaunt-react-native', 'src/sdks/react-native'],
  ['oliphaunt-wasix-rust', 'src/bindings/wasix-rust/crates/oliphaunt-wasix'],
]);

const FORBIDDEN_PATH_PARTS = [
  '/node_modules/',
  '/target/',
  '/.build/',
  '/DerivedData/',
  '/build/',
  '/.cxx/',
  '/generated/',
  '/vendor/',
];

const ROOT = path.resolve(import.meta.dir, '..', '..');
const BASELINE = path.join(ROOT, 'coverage/baseline.toml');
const COVERAGE_ROOT = path.join(ROOT, 'target/coverage');
const globRegexCache = new Map();

function fail(message) {
  console.error(`coverage.mjs: ${message}`);
  process.exit(1);
}

function posixPath(value) {
  return value.split(path.sep).join('/');
}

function relPath(value) {
  const raw = String(value);
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(ROOT, raw);
  const relative = path.relative(ROOT, resolved);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return posixPath(relative);
  }
  return posixPath(raw);
}

function run(command, { cwd = ROOT, env = process.env } = {}) {
  console.log(`\n==> ${command.join(' ')}`);
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    env,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function capture(command, { cwd = ROOT, env = process.env } = {}) {
  console.log(`\n==> ${command.join(' ')}`);
  const result = captureCommandOutput(command[0], command.slice(1), {
    cwd,
    env,
    label: command.join(' '),
  });
  if (result.error) {
    throw result.error;
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(output);
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return output;
}

function optionalCapture(command, { cwd = ROOT } = {}) {
  const result = captureCommandOutput(command[0], command.slice(1), {
    cwd,
    label: command.join(' '),
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  const value = result.stdout.trim();
  return value || null;
}

function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function which(name) {
  const pathValue = process.env.PATH ?? '';
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (existsSync(candidate) && statSync(candidate).isFile() && isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function requireTool(name, installHint) {
  if (which(name) === null) {
    fail(`missing required coverage tool: ${name}\n\nInstall with:\n  ${installHint}`);
  }
}

function commandOk(command) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: ROOT,
    stdio: 'ignore',
  });
  return !result.error && result.status === 0;
}

function loadBaseline() {
  if (!existsSync(BASELINE) || !statSync(BASELINE).isFile()) {
    fail(`missing coverage baseline: ${relPath(BASELINE)}`);
  }
  const data = Bun.TOML.parse(readFileSync(BASELINE, 'utf8'));
  if (!data.products || typeof data.products !== 'object' || Array.isArray(data.products)) {
    fail('coverage baseline must define [products.<id>] tables');
  }
  return data;
}

function productConfig(product) {
  const data = loadBaseline();
  const config = data.products[product];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    fail(`coverage baseline does not define product ${JSON.stringify(product)}`);
  }
  return config;
}

function outputDir(product) {
  return path.join(COVERAGE_ROOT, product);
}

function productSourceRoot(product) {
  const source = PRODUCT_SOURCE_ROOTS.get(product);
  if (source === undefined) {
    fail(`missing source root mapping for coverage product ${product}`);
  }
  return path.join(ROOT, source);
}

function productSourcePrefix(product) {
  return relPath(productSourceRoot(product));
}

function resetOutput(product) {
  const out = outputDir(product);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  return out;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function repoGlobRegex(pattern) {
  const normalized = pattern.replaceAll(path.sep, '/');
  const cached = globRegexCache.get(normalized);
  if (cached !== undefined) {
    return cached;
  }
  const parts = ['^'];
  let index = 0;
  while (index < normalized.length) {
    const char = normalized[index];
    if (char === '*') {
      if (index + 1 < normalized.length && normalized[index + 1] === '*') {
        index += 2;
        if (index < normalized.length && normalized[index] === '/') {
          index += 1;
          parts.push('(?:.*/)?');
        } else {
          parts.push('.*');
        }
        continue;
      }
      parts.push('[^/]*');
    } else if (char === '?') {
      parts.push('[^/]');
    } else {
      parts.push(escapeRegExp(char));
    }
    index += 1;
  }
  parts.push('$');
  const regex = new RegExp(parts.join(''), 'u');
  globRegexCache.set(normalized, regex);
  return regex;
}

function matchesAny(file, patterns) {
  const normalized = file.replaceAll(path.sep, '/');
  return patterns.some((pattern) => repoGlobRegex(pattern).test(normalized));
}

function sourceGlobs(config) {
  const globs = config.source_globs;
  if (!Array.isArray(globs) || globs.length === 0 || !globs.every((item) => typeof item === 'string')) {
    fail('coverage product config must define non-empty source_globs');
  }
  return globs;
}

function excludeGlobs(config) {
  const globs = config.exclude_globs ?? [];
  if (!Array.isArray(globs) || !globs.every((item) => typeof item === 'string')) {
    fail('coverage product config exclude_globs must be a list of strings');
  }
  return globs;
}

function waiverEntries(config) {
  const entries = config.waivers ?? [];
  if (!Array.isArray(entries)) {
    fail('coverage waivers must be an array of tables');
  }
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('coverage waiver entries must be tables');
    }
    const exact = entry.path;
    const pattern = entry.glob;
    if ((exact === undefined) === (pattern === undefined)) {
      fail('coverage waiver must define exactly one of path or glob');
    }
    for (const [key, value] of [
      ['path/glob', exact ?? pattern],
      ['reason', entry.reason],
      ['evidence', entry.evidence],
      ['owner', entry.owner],
      ['expires', entry.expires],
    ]) {
      if (typeof value !== 'string') {
        fail(`coverage waiver ${key}, reason, evidence, owner, and expires must be strings`);
      }
      if (key !== 'path/glob' && value.trim() === '') {
        fail('coverage waiver reason, evidence, owner, and expires must be non-empty');
      }
    }
    return {
      path: exact ?? '',
      glob: pattern ?? '',
      reason: entry.reason,
      evidence: entry.evidence,
      owner: entry.owner,
      expires: entry.expires,
    };
  });
}

function waiverPatterns(config) {
  return waiverEntries(config).map((waiver) => waiver.path || waiver.glob);
}

function isWaived(file, config) {
  const relative = relPath(file);
  for (const waiver of waiverEntries(config)) {
    if (waiver.path && relative === waiver.path) {
      return true;
    }
    if (waiver.glob && matchesAny(relative, [waiver.glob])) {
      return true;
    }
  }
  return false;
}

function allowedFile(file, config) {
  const relative = relPath(file);
  const normalized = `/${relative}`;
  if (!matchesAny(relative, sourceGlobs(config))) {
    return false;
  }
  if (matchesAny(relative, excludeGlobs(config))) {
    return false;
  }
  if (isWaived(relative, config)) {
    return false;
  }
  return !FORBIDDEN_PATH_PARTS.some((part) => normalized.includes(part));
}

function staticGlobPrefix(pattern) {
  const wildcardIndex = pattern.search(/[*?]/u);
  if (wildcardIndex === -1) {
    return pattern;
  }
  const slashIndex = pattern.lastIndexOf('/', wildcardIndex);
  return slashIndex === -1 ? '.' : pattern.slice(0, slashIndex);
}

function walkFiles(root) {
  if (!existsSync(root)) {
    return [];
  }
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  }
  return files.sort();
}

function trackedOrLocalSourceFiles(config) {
  const files = new Set();
  for (const pattern of sourceGlobs(config)) {
    const prefix = staticGlobPrefix(pattern);
    for (const candidate of walkFiles(path.join(ROOT, prefix))) {
      const relative = relPath(candidate);
      if (matchesAny(relative, [pattern])) {
        files.add(relative);
      }
    }
  }
  return [...files].sort();
}

function validateWaivers(config) {
  const files = trackedOrLocalSourceFiles(config);
  for (const waiver of waiverEntries(config)) {
    const matched = files.filter((file) =>
      (waiver.path && file === waiver.path) ||
      (waiver.glob && matchesAny(file, [waiver.glob]))
    );
    if (matched.length === 0) {
      fail(`coverage waiver does not match an owned source file: ${waiver.path || waiver.glob}`);
    }
  }
  return waiverEntries(config);
}

function ownedUnwaivedSourceFiles(config) {
  validateWaivers(config);
  const owned = [];
  for (const file of trackedOrLocalSourceFiles(config)) {
    const normalized = `/${file}`;
    if (matchesAny(file, excludeGlobs(config))) {
      continue;
    }
    if (isWaived(file, config)) {
      continue;
    }
    if (FORBIDDEN_PATH_PARTS.some((part) => normalized.includes(part))) {
      continue;
    }
    owned.push(file);
  }
  return owned.sort();
}

function percent(covered, total) {
  if (total <= 0) {
    return 0.0;
  }
  return Math.round((covered / total) * 10000) / 100;
}

function parseLcov(reportPath, config) {
  const files = [];
  let currentFile = null;
  let currentLines = new Map();
  const flush = () => {
    if (currentFile === null) {
      return;
    }
    if (allowedFile(currentFile, config)) {
      const total = currentLines.size;
      const covered = [...currentLines.values()].filter((count) => count > 0).length;
      if (total > 0) {
        files.push({ path: relPath(currentFile), covered_lines: covered, total_lines: total });
      }
    }
    currentFile = null;
    currentLines = new Map();
  };
  for (const rawLine of readFileSync(reportPath, 'utf8').split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (line.startsWith('SF:')) {
      flush();
      currentFile = line.slice(3);
    } else if (line.startsWith('DA:') && currentFile !== null) {
      const [lineNo, count] = line.slice(3).split(',');
      currentLines.set(Number.parseInt(lineNo, 10), Number.parseInt(count, 10));
    } else if (line === 'end_of_record') {
      flush();
    }
  }
  flush();
  const covered = files.reduce((sum, file) => sum + file.covered_lines, 0);
  const total = files.reduce((sum, file) => sum + file.total_lines, 0);
  return { covered, total, files };
}

function normalizeJavascriptReportPath(product, rawPath) {
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }
  const sourcePrefix = productSourcePrefix(product);
  if (rawPath.startsWith(`${sourcePrefix}/`)) {
    return rawPath;
  }
  return `${sourcePrefix}/${rawPath}`;
}

function parseJavascriptSummary(reportPath, product, config) {
  const data = JSON.parse(readFileSync(reportPath, 'utf8'));
  const files = [];
  for (const [rawPath, entry] of Object.entries(data)) {
    const sourcePath = normalizeJavascriptReportPath(product, rawPath);
    if (rawPath === 'total' || !allowedFile(sourcePath, config)) {
      continue;
    }
    const lines = entry.lines ?? {};
    const total = Number.parseInt(lines.total ?? 0, 10);
    const covered = Number.parseInt(lines.covered ?? 0, 10);
    if (total > 0) {
      files.push({ path: relPath(sourcePath), covered_lines: covered, total_lines: total });
    }
  }
  return {
    covered: files.reduce((sum, file) => sum + file.covered_lines, 0),
    total: files.reduce((sum, file) => sum + file.total_lines, 0),
    files,
  };
}

function xmlUnescape(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function parseXmlAttributes(raw) {
  const attributes = new Map();
  for (const match of raw.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/gu)) {
    attributes.set(match[1], xmlUnescape(match[2]));
  }
  return attributes;
}

function resolveKoverSourcePath(packageName, sourceFileName) {
  const packagePath = packageName.replaceAll('.', '/');
  const sourceRoot = path.join(productSourceRoot('oliphaunt-kotlin'), 'oliphaunt/src');
  const candidates = walkFiles(sourceRoot)
    .filter((candidate) => posixPath(candidate).endsWith(`${packagePath}/${sourceFileName}`))
    .sort();
  const sourceCandidates = candidates.filter((candidate) => !candidate.split(path.sep).includes('Test'));
  if (sourceCandidates.length > 0) {
    return relPath(sourceCandidates[0]);
  }
  if (candidates.length > 0) {
    return relPath(candidates[0]);
  }
  return `src/sdks/kotlin/oliphaunt/src/${packagePath}/${sourceFileName}`;
}

function parseKoverXml(reportPath, config) {
  const xml = readFileSync(reportPath, 'utf8');
  const files = [];
  for (const packageMatch of xml.matchAll(/<package\b([^>]*)>([\s\S]*?)<\/package>/gu)) {
    const packageName = parseXmlAttributes(packageMatch[1]).get('name') ?? '';
    for (const sourceMatch of packageMatch[2].matchAll(/<sourcefile\b([^>]*)>([\s\S]*?)<\/sourcefile>/gu)) {
      const sourceFileName = parseXmlAttributes(sourceMatch[1]).get('name') ?? '';
      const sourcePath = resolveKoverSourcePath(packageName, sourceFileName);
      if (!allowedFile(sourcePath, config)) {
        continue;
      }
      const lines = [...sourceMatch[2].matchAll(/<line\b([^>]*)\/?>/gu)];
      const total = lines.length;
      const covered = lines.filter((line) => {
        const attributes = parseXmlAttributes(line[1]);
        return Number.parseInt(attributes.get('ci') ?? '0', 10) > 0;
      }).length;
      if (total > 0) {
        files.push({ path: sourcePath, covered_lines: covered, total_lines: total });
      }
    }
  }
  return {
    covered: files.reduce((sum, file) => sum + file.covered_lines, 0),
    total: files.reduce((sum, file) => sum + file.total_lines, 0),
    files,
  };
}

function parseSwiftJson(reportPath, config) {
  const data = JSON.parse(readFileSync(reportPath, 'utf8'));
  const files = [];
  for (const report of data.data ?? []) {
    for (const fileEntry of report.files ?? []) {
      const filename = fileEntry.filename ?? fileEntry.name;
      if (!filename || !allowedFile(filename, config)) {
        continue;
      }
      const lines = fileEntry.summary?.lines ?? {};
      const total = Number.parseInt(lines.count ?? lines.total ?? 0, 10);
      const covered = Number.parseInt(lines.covered ?? 0, 10);
      if (total > 0) {
        files.push({ path: relPath(filename), covered_lines: covered, total_lines: total });
      }
    }
  }
  return {
    covered: files.reduce((sum, file) => sum + file.covered_lines, 0),
    total: files.reduce((sum, file) => sum + file.total_lines, 0),
    files,
  };
}

function sortForJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortForJson);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortForJson(item)]),
    );
  }
  return value;
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(sortForJson(value), null, 2)}\n`);
}

function writeSummary(product, tool, coveredLines, totalLines, files, reports) {
  const out = outputDir(product);
  const config = productConfig(product);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const summary = {
    schema: 'oliphaunt-coverage-summary-v1',
    product,
    tool,
    line_coverage: percent(coveredLines, totalLines),
    line_threshold: Number.parseFloat(config.line_threshold),
    covered_lines: coveredLines,
    total_lines: totalLines,
    files,
    reports: reports.map(relPath),
    source_globs: sourceGlobs(config),
    exclude_globs: excludeGlobs(config),
    waived_files: waiverEntries(config).map((waiver) => ({
      path: waiver.path || waiver.glob,
      reason: waiver.reason,
      evidence: waiver.evidence,
      owner: waiver.owner,
      expires: waiver.expires,
    })),
  };
  const summaryPath = path.join(out, 'summary.json');
  writeJson(summaryPath, summary);
  return summaryPath;
}

function checkSummary(product) {
  const config = productConfig(product);
  const summaryPath = path.join(ROOT, config.summary);
  if (!existsSync(summaryPath) || !statSync(summaryPath).isFile()) {
    fail(`${product}: missing measured coverage summary ${relPath(summaryPath)}`);
  }
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  if (summary.product !== product) {
    fail(`${product}: coverage summary product mismatch`);
  }
  const total = Number.parseInt(summary.total_lines ?? 0, 10);
  const covered = Number.parseInt(summary.covered_lines ?? 0, 10);
  if (total <= 0 || covered <= 0) {
    fail(`${product}: coverage summary is unmeasured: covered=${covered} total=${total}`);
  }
  const files = summary.files;
  if (!Array.isArray(files) || files.length === 0) {
    fail(`${product}: coverage summary contains no measured source files`);
  }
  const measured = Number.parseFloat(summary.line_coverage ?? 0.0);
  const threshold = Number.parseFloat(config.line_threshold);
  const committedMeasured = Number.parseFloat(config.measured_line_coverage ?? 0.0);
  if (committedMeasured < threshold) {
    fail(`${product}: committed measured_line_coverage is below line_threshold`);
  }
  if (measured + 0.005 < threshold) {
    fail(`${product}: line coverage ${measured.toFixed(2)}% is below threshold ${threshold.toFixed(2)}%`);
  }
  const summaryReports = new Set(summary.reports ?? []);
  for (const report of config.reports ?? []) {
    if (!summaryReports.has(report)) {
      fail(`${product}: coverage summary is missing expected report ${report}`);
    }
  }
  for (const report of summaryReports) {
    const reportPath = path.join(ROOT, report);
    if (!existsSync(reportPath) || !statSync(reportPath).isFile() || statSync(reportPath).size === 0) {
      fail(`${product}: missing or empty coverage report ${report}`);
    }
  }
  for (const file of files) {
    const sourcePath = file.path ?? '';
    const normalized = `/${sourcePath}`;
    if (FORBIDDEN_PATH_PARTS.some((part) => normalized.includes(part))) {
      fail(`${product}: coverage includes generated/vendor/build path ${sourcePath}`);
    }
    if (!allowedFile(sourcePath, config)) {
      fail(`${product}: coverage includes a source path outside the baseline scope: ${sourcePath}`);
    }
  }
  const perFileThreshold = Number.parseFloat(config.per_file_line_threshold ?? 0.0);
  if (perFileThreshold > 0.0) {
    for (const file of files) {
      const sourcePath = file.path ?? '';
      const fileTotal = Number.parseInt(file.total_lines ?? 0, 10);
      const fileCovered = Number.parseInt(file.covered_lines ?? 0, 10);
      const filePercent = percent(fileCovered, fileTotal);
      if (filePercent + 0.005 < perFileThreshold) {
        fail(`${product}: ${sourcePath} line coverage ${filePercent.toFixed(2)}% is below per-file threshold ${perFileThreshold.toFixed(2)}%`);
      }
    }
  }
  const measuredPaths = new Set(files.map((file) => file.path ?? ''));
  const missingOwned = ownedUnwaivedSourceFiles(config).filter((file) => !measuredPaths.has(file));
  if (missingOwned.length > 0) {
    fail(
      `${product}: owned source files are neither measured nor waived: ` +
      missingOwned.slice(0, 20).join(', ') +
      (missingOwned.length > 20 ? ' ...' : ''),
    );
  }
  return summary;
}

function runRust(product) {
  const packageName = product === 'oliphaunt-rust' ? 'oliphaunt' : 'oliphaunt-wasix';
  const out = resetOutput(product);
  const lcov = path.join(out, 'lcov.info');
  requireTool('cargo', 'rustup toolchain install 1.93.1');
  if (!commandOk(['cargo', 'llvm-cov', '--version'])) {
    fail('missing required coverage tool: cargo-llvm-cov\n\nInstall with:\n  cargo install cargo-llvm-cov --version 0.8.7 --locked');
  }
  if (!commandOk(['cargo', 'nextest', '--version'])) {
    fail('missing required coverage tool: cargo-nextest\n\nInstall with:\n  cargo install cargo-nextest --version 0.9.137 --locked');
  }
  const env = { ...process.env };
  if (env.LLVM_COV === undefined) {
    const llvmCov = which('llvm-cov') ?? optionalCapture(['xcrun', '--find', 'llvm-cov']);
    if (llvmCov) {
      env.LLVM_COV = llvmCov;
    }
  }
  if (env.LLVM_PROFDATA === undefined) {
    const llvmProfdata = which('llvm-profdata') ?? optionalCapture(['xcrun', '--find', 'llvm-profdata']);
    if (llvmProfdata) {
      env.LLVM_PROFDATA = llvmProfdata;
    }
  }
  const featureArgs = product === 'oliphaunt-wasix-rust' ? ['--no-default-features'] : [];
  const targetArgs = product === 'oliphaunt-wasix-rust' ? ['--lib'] : [];
  run(['cargo', 'llvm-cov', 'clean', '--profraw-only'], { env });
  run(
    [
      'cargo',
      'llvm-cov',
      'nextest',
      '--package',
      packageName,
      ...targetArgs,
      ...featureArgs,
      '--locked',
      '--profile',
      'ci',
      '--no-tests=fail',
      '--test-threads=1',
      '--no-report',
    ],
    { env },
  );
  run(['cargo', 'test', '--doc', '--package', packageName, '--locked'], { env });
  run(['cargo', 'llvm-cov', 'report', '--lcov', '--output-path', lcov], { env });
  const parsed = parseLcov(lcov, productConfig(product));
  writeSummary(product, 'cargo-llvm-cov', parsed.covered, parsed.total, parsed.files, [lcov]);
  checkSummary(product);
}

function runSwift() {
  const out = resetOutput('oliphaunt-swift');
  const scratch = path.join(ROOT, 'target/coverage-build/oliphaunt-swift');
  rmSync(scratch, { recursive: true, force: true });
  requireTool('swift', 'Install Xcode or the Swift toolchain');
  run([
    'swift',
    'test',
    '--package-path',
    ROOT,
    '--scratch-path',
    scratch,
    '--enable-code-coverage',
  ]);
  const output = capture([
    'swift',
    'test',
    '--package-path',
    ROOT,
    '--scratch-path',
    scratch,
    '--show-codecov-path',
  ]);
  let candidates = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.json') && existsSync(line) && statSync(line).isFile());
  if (candidates.length === 0) {
    candidates = walkFiles(scratch).filter((candidate) => candidate.endsWith('.json'));
  }
  if (candidates.length === 0) {
    fail('oliphaunt-swift: swift test did not emit a code coverage JSON path');
  }
  const report = path.join(out, 'swift-coverage.json');
  copyFileSync(candidates.at(-1), report);
  const parsed = parseSwiftJson(report, productConfig('oliphaunt-swift'));
  writeSummary('oliphaunt-swift', 'swift test --enable-code-coverage', parsed.covered, parsed.total, parsed.files, [report]);
  checkSummary('oliphaunt-swift');
}

function runKotlin() {
  const out = resetOutput('oliphaunt-kotlin');
  requireTool('java', 'Install JDK 17');
  const packageDir = productSourceRoot('oliphaunt-kotlin');
  const gradle = path.join(packageDir, 'gradlew');
  const buildRoot = path.join(ROOT, 'target/coverage-build/oliphaunt-kotlin/gradle');
  const cxxBuildRoot = path.join(ROOT, 'target/coverage-build/oliphaunt-kotlin/cxx');
  const projectCache = path.join(ROOT, 'target/coverage-build/oliphaunt-kotlin/gradle-cache');
  rmSync(buildRoot, { recursive: true, force: true });
  rmSync(cxxBuildRoot, { recursive: true, force: true });
  run([
    gradle,
    '-p',
    relPath(packageDir),
    ':oliphaunt:koverXmlReport',
    ':oliphaunt:koverVerify',
    '--no-daemon',
    `-PoliphauntBuildRoot=${buildRoot}`,
    `-PoliphauntCxxBuildRoot=${cxxBuildRoot}`,
    '--project-cache-dir',
    projectCache,
  ]);
  let reports = walkFiles(buildRoot)
    .filter((candidate) => posixPath(candidate).includes('/reports/kover/') && candidate.endsWith('.xml'))
    .sort();
  if (reports.length === 0) {
    reports = walkFiles(packageDir)
      .filter((candidate) => posixPath(candidate).includes('/build/reports/kover/') && candidate.endsWith('.xml'))
      .sort();
  }
  if (reports.length === 0) {
    fail('oliphaunt-kotlin: Kover did not emit an XML report');
  }
  const report = path.join(out, 'kover.xml');
  copyFileSync(reports.at(-1), report);
  const parsed = parseKoverXml(report, productConfig('oliphaunt-kotlin'));
  writeSummary('oliphaunt-kotlin', 'kover', parsed.covered, parsed.total, parsed.files, [report]);
  checkSummary('oliphaunt-kotlin');
}

function runJavascript(product) {
  const out = resetOutput(product);
  const packageDir = productSourceRoot(product);
  requireTool(
    'pnpm',
    'export PATH="$(bash .github/actions/setup-node-pnpm/install-pinned-pnpm.sh)/bin:$PATH"',
  );
  const config = productConfig(product);
  const threshold = String(Math.trunc(Number.parseFloat(config.line_threshold)));
  const sourcePrefix = `${productSourcePrefix(product)}/`;
  const includePatterns = sourceGlobs(config).map((pattern) =>
    pattern.startsWith(sourcePrefix) ? pattern.slice(sourcePrefix.length) : pattern
  );
  const excludePatterns = [...excludeGlobs(config), ...waiverPatterns(config)].map((pattern) =>
    pattern.startsWith(sourcePrefix) ? pattern.slice(sourcePrefix.length) : pattern
  );
  const env = {
    ...process.env,
    OLIPHAUNT_VITEST_COVERAGE: '1',
    OLIPHAUNT_VITEST_COVERAGE_DIR: out,
    OLIPHAUNT_VITEST_COVERAGE_INCLUDE: JSON.stringify(includePatterns),
    OLIPHAUNT_VITEST_COVERAGE_EXCLUDE: JSON.stringify(excludePatterns),
    OLIPHAUNT_VITEST_COVERAGE_LINES: threshold,
  };
  run(['pnpm', '--dir', packageDir, 'test'], { env });
  const summaryReport = path.join(out, 'coverage-summary.json');
  if (!existsSync(summaryReport) || !statSync(summaryReport).isFile()) {
    fail(`${product}: Vitest did not emit ${relPath(summaryReport)}`);
  }
  const parsed = parseJavascriptSummary(summaryReport, product, config);
  const reports = [summaryReport];
  const lcov = path.join(out, 'lcov.info');
  if (existsSync(lcov) && statSync(lcov).isFile()) {
    reports.push(lcov);
  }
  writeSummary(product, 'vitest-v8', parsed.covered, parsed.total, parsed.files, reports);
  checkSummary(product);
}

function runProduct(product) {
  if (!PRODUCTS.includes(product)) {
    fail(`unknown product ${JSON.stringify(product)}; expected one of ${PRODUCTS.join(', ')}`);
  }
  if (product === 'oliphaunt-rust' || product === 'oliphaunt-wasix-rust') {
    runRust(product);
  } else if (product === 'oliphaunt-swift') {
    runSwift();
  } else if (product === 'oliphaunt-kotlin') {
    runKotlin();
  } else if (product === 'oliphaunt-js' || product === 'oliphaunt-react-native') {
    runJavascript(product);
  } else {
    fail(`unhandled coverage product ${product}`);
  }
}

function parseProductsJson(value) {
  if (value === undefined || value.trim() === '') {
    return [...PRODUCTS];
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    fail(`coverage products JSON is invalid: ${error.message}`);
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    fail('coverage products JSON must be a string array');
  }
  const unknown = [...new Set(parsed.filter((item) => !PRODUCTS.includes(item)))].sort();
  if (unknown.length > 0) {
    fail(`unknown coverage product(s): ${unknown.join(', ')}`);
  }
  return [...new Set(parsed)].sort((left, right) => PRODUCTS.indexOf(left) - PRODUCTS.indexOf(right));
}

function summarize({ allowMissing = false, productsJson } = {}) {
  const data = loadBaseline();
  const products = data.products;
  const selectedProducts = parseProductsJson(productsJson);
  const rows = [];
  const allSummaries = [];
  for (const product of selectedProducts) {
    if (!Object.hasOwn(products, product)) {
      if (data.policy?.fail_on_unmeasured_product ?? true) {
        fail(`missing coverage baseline for ${product}`);
      }
      continue;
    }
    const summaryPath = path.join(ROOT, products[product].summary);
    if (allowMissing && (!existsSync(summaryPath) || !statSync(summaryPath).isFile())) {
      continue;
    }
    if (!existsSync(summaryPath) || !statSync(summaryPath).isFile()) {
      fail(`missing required coverage summary: ${relPath(summaryPath)}`);
    }
    const summary = checkSummary(product);
    allSummaries.push(summary);
    rows.push(
      `| ${summary.product} | ${summary.tool} | ${summary.line_coverage.toFixed(2)}% | ` +
      `${summary.line_threshold.toFixed(2)}% | ${summary.covered_lines}/${summary.total_lines} |`,
    );
  }
  mkdirSync(COVERAGE_ROOT, { recursive: true });
  writeJson(path.join(COVERAGE_ROOT, 'summary.json'), {
    schema: 'oliphaunt-coverage-aggregate-v1',
    products: allSummaries,
  });
  const markdown = [
    '| Product | Tool | Lines | Threshold | Covered |',
    '| --- | --- | ---: | ---: | ---: |',
    ...rows,
    '',
  ].join('\n');
  writeFileSync(path.join(COVERAGE_ROOT, 'summary.md'), markdown);
  console.log(markdown);
}

function checkTools() {
  const data = loadBaseline();
  for (const product of PRODUCTS) {
    if (!data.products[product]) {
      fail(`missing coverage baseline for ${product}`);
    }
    validateWaivers(data.products[product]);
    sourceGlobs(data.products[product]);
    excludeGlobs(data.products[product]);
  }
  console.log('coverage tooling checks passed');
}

function usage() {
  return `usage:
  tools/coverage/coverage.mjs run-product <product>
  tools/coverage/coverage.mjs check-product <product>
  tools/coverage/coverage.mjs summarize [--allow-missing] [--products-json JSON]
  tools/coverage/coverage.mjs check-tools`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command === undefined || command === '-h' || command === '--help') {
    console.log(usage());
    process.exit(0);
  }
  if (command === 'run-product' || command === 'check-product') {
    if (rest.length !== 1 || !PRODUCTS.includes(rest[0])) {
      fail(`${command} requires one product: ${PRODUCTS.join(', ')}`);
    }
    return { command, product: rest[0] };
  }
  if (command === 'summarize') {
    const options = { command, allowMissing: false, productsJson: undefined };
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index];
      if (arg === '--allow-missing') {
        options.allowMissing = true;
      } else if (arg === '--products-json') {
        index += 1;
        if (index >= rest.length) {
          fail('--products-json requires a value');
        }
        options.productsJson = rest[index];
      } else {
        fail(`unknown summarize argument: ${arg}`);
      }
    }
    return options;
  }
  if (command === 'check-tools') {
    if (rest.length !== 0) {
      fail('check-tools does not take arguments');
    }
    return { command };
  }
  fail(`unknown command: ${command}\n${usage()}`);
}

const args = parseArgs(Bun.argv.slice(2));
if (args.command === 'run-product') {
  runProduct(args.product);
} else if (args.command === 'check-product') {
  const summary = checkSummary(args.product);
  console.log(`${args.product}: ${summary.line_coverage.toFixed(2)}% line coverage`);
} else if (args.command === 'summarize') {
  summarize({ allowMissing: args.allowMissing, productsJson: args.productsJson });
} else if (args.command === 'check-tools') {
  checkTools();
}

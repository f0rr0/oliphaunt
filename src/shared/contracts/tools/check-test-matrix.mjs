#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const CONTRACTS_ROOT = path.join(ROOT, 'src/shared/contracts');
const FIXTURES_ROOT = path.join(ROOT, 'src/shared/fixtures');
const MATRIX_PATH = path.join(CONTRACTS_ROOT, 'test-matrix.toml');
const GENERATED_MANIFEST = path.join(ROOT, 'target/shared-fixtures/manifest.generated.json');
const GENERATED_CONSUMPTION_REPORT = path.join(ROOT, 'target/shared-fixtures/consumption-report.json');
const ID_RE = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u;
const FORMATS = new Set(['json', 'properties', 'tsv']);
const EVIDENCE_KINDS = new Set(['fixture-file', 'semantic-contract']);
const CONSUMPTION_SCAN_ROOTS = [
  'src/sdks/rust/tests',
  'src/sdks/swift/Tests',
  'src/sdks/kotlin/oliphaunt/src',
  'src/sdks/js/src',
  'src/sdks/react-native/src',
  'src/bindings/wasix-rust/crates/oliphaunt-wasix/src',
  'tools/release',
];
const CODE_SUFFIXES = new Set([
  '.bash',
  '.c',
  '.cjs',
  '.cpp',
  '.gradle',
  '.h',
  '.java',
  '.js',
  '.kt',
  '.kts',
  '.mjs',
  '.mm',
  '.py',
  '.rs',
  '.sh',
  '.swift',
  '.ts',
  '.tsx',
]);
const IGNORED_DIR_NAMES = new Set([
  '.build',
  '.gradle',
  '.moon',
  '.next',
  '__pycache__',
  'build',
  'DerivedData',
  'dist',
  'lib',
  'node_modules',
  'target',
]);
const PROJECT_ROOTS = {
  'src/runtimes/liboliphaunt/native': 'liboliphaunt-native',
  'src/sdks/rust': 'oliphaunt-rust',
  'src/sdks/swift': 'oliphaunt-swift',
  'src/sdks/kotlin': 'oliphaunt-kotlin',
  'src/sdks/js': 'oliphaunt-js',
  'src/sdks/react-native': 'oliphaunt-react-native',
  'src/bindings/wasix-rust': 'oliphaunt-wasix-rust',
  'tools/policy': 'policy-tools',
  'tools/release': 'release-tools',
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

function posixRelative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = stableValue(value[key]);
  }
  return sorted;
}

function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function requireString(entry, key) {
  const value = entry?.[key];
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${MATRIX_PATH}: fixture entry missing string ${JSON.stringify(key)}`);
  }
  return value;
}

function isSafeRelative(relativePath) {
  const parts = relativePath.split(/[\\/]/u);
  return !path.isAbsolute(relativePath) && !parts.includes('..');
}

function loadMatrix() {
  try {
    return Bun.TOML.parse(readText(MATRIX_PATH));
  } catch (error) {
    fail(`${MATRIX_PATH}: invalid TOML: ${error.message}`);
  }
}

function validateFixtureEntry(entry, seen) {
  const fixtureId = requireString(entry, 'id');
  if (!ID_RE.test(fixtureId)) {
    fail(`${MATRIX_PATH}: invalid fixture id ${JSON.stringify(fixtureId)}`);
  }
  if (seen.has(fixtureId)) {
    fail(`${MATRIX_PATH}: duplicate fixture id ${JSON.stringify(fixtureId)}`);
  }
  seen.add(fixtureId);

  const relativePath = requireString(entry, 'path');
  if (!isSafeRelative(relativePath)) {
    fail(`${MATRIX_PATH}: fixture ${fixtureId} has unsafe path ${JSON.stringify(relativePath)}`);
  }

  const fixtureFormat = requireString(entry, 'format');
  if (!FORMATS.has(fixtureFormat)) {
    fail(`${MATRIX_PATH}: fixture ${fixtureId} has unsupported format ${JSON.stringify(fixtureFormat)}`);
  }

  const contract = requireString(entry, 'contract');
  const proofOwner = requireString(entry, 'proof_owner');
  const ciTier = requireString(entry, 'ci_tier');
  if (!/^T[0-8]$/u.test(ciTier)) {
    fail(`${MATRIX_PATH}: fixture ${fixtureId} has invalid ci_tier ${JSON.stringify(ciTier)}`);
  }

  const consumers = entry.consumers;
  if (!Array.isArray(consumers) || consumers.length === 0 || !consumers.every((item) => typeof item === 'string' && item.length > 0)) {
    fail(`${MATRIX_PATH}: fixture ${fixtureId} must declare non-empty string consumers`);
  }
  const nonConsumers = entry.non_consumers;
  if (!Array.isArray(nonConsumers) || !nonConsumers.every((item) => typeof item === 'string' && item.length > 0)) {
    fail(`${MATRIX_PATH}: fixture ${fixtureId} must declare string non_consumers`);
  }
  const overlap = consumers.filter((consumer) => nonConsumers.includes(consumer)).sort();
  if (overlap.length > 0) {
    fail(`${MATRIX_PATH}: fixture ${fixtureId} declares consumers as non-consumers: ${JSON.stringify(overlap)}`);
  }

  const shared = entry.shared;
  if (typeof shared !== 'boolean') {
    fail(`${MATRIX_PATH}: fixture ${fixtureId} must declare shared = true/false`);
  }
  if (shared && new Set(consumers).size < 2) {
    fail(`${MATRIX_PATH}: shared fixture ${fixtureId} must have at least two consumers`);
  }
  if (!shared && typeof entry.reason !== 'string') {
    fail(`${MATRIX_PATH}: product-specific fixture ${fixtureId} must explain why it is cataloged`);
  }

  const evidence = entry.evidence ?? [];
  if (!Array.isArray(evidence) || evidence.length === 0) {
    fail(`${MATRIX_PATH}: fixture ${fixtureId} must declare evidence for every consumer`);
  }
  const evidenceConsumers = [];
  for (const item of evidence) {
    if (!isPlainObject(item)) {
      fail(`${MATRIX_PATH}: fixture ${fixtureId} evidence entries must be TOML tables`);
    }
    const consumer = requireString(item, 'consumer');
    if (!consumers.includes(consumer)) {
      fail(`${MATRIX_PATH}: fixture ${fixtureId} has evidence for undeclared consumer ${JSON.stringify(consumer)}`);
    }
    evidenceConsumers.push(consumer);
    const kind = item.kind ?? 'fixture-file';
    if (!EVIDENCE_KINDS.has(kind)) {
      fail(`${MATRIX_PATH}: fixture ${fixtureId} evidence for ${consumer} has unsupported kind ${JSON.stringify(kind)}`);
    }
    const evidencePath = requireString(item, 'path');
    if (!isSafeRelative(evidencePath)) {
      fail(`${MATRIX_PATH}: fixture ${fixtureId} evidence for ${consumer} has unsafe path ${JSON.stringify(evidencePath)}`);
    }
    const markers = item.markers;
    if (!Array.isArray(markers) || markers.length === 0 || !markers.every((marker) => typeof marker === 'string' && marker.length > 0)) {
      fail(`${MATRIX_PATH}: fixture ${fixtureId} evidence for ${consumer} must declare non-empty string markers`);
    }
  }
  const missingEvidence = consumers.filter((consumer) => !evidenceConsumers.includes(consumer)).sort();
  if (missingEvidence.length > 0) {
    fail(`${MATRIX_PATH}: fixture ${fixtureId} lacks evidence for consumers: ${JSON.stringify(missingEvidence)}`);
  }

  return {
    id: fixtureId,
    path: relativePath,
    format: fixtureFormat,
    contract,
    proof_owner: proofOwner,
    ci_tier: ciTier,
    shared,
    consumers,
    non_consumers: nonConsumers,
    evidence,
  };
}

function validateProperties(file) {
  const entries = readText(file)
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0 && !line.trimStart().startsWith('#'));
  if (entries.length === 0) {
    fail(`${file}: properties fixture is empty`);
  }
  for (const line of entries) {
    if (!line.includes('=')) {
      fail(`${file}: properties line lacks '=': ${JSON.stringify(line)}`);
    }
  }
}

function parseTsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === '\t' && !quoted) {
      cells.push(cell);
      cell = '';
      continue;
    }
    cell += char;
  }
  cells.push(cell);
  return cells;
}

function validateTsv(file) {
  const rows = readText(file)
    .replace(/\r\n/gu, '\n')
    .replace(/\r/gu, '\n')
    .split('\n')
    .filter((line, index, lines) => index < lines.length - 1 || line.length > 0)
    .map(parseTsvLine);
  if (rows.length < 2) {
    fail(`${file}: TSV fixture must contain a header and at least one data row`);
  }
  const width = rows[0].length;
  if (width === 0) {
    fail(`${file}: TSV fixture header is empty`);
  }
  rows.slice(1).forEach((row, index) => {
    if (row.length !== width) {
      fail(`${file}: row ${index + 2} has ${row.length} cells, expected ${width}`);
    }
  });
}

function validateEvidenceFile(fixture, evidence) {
  const evidencePath = path.join(ROOT, evidence.path);
  if (!fs.existsSync(evidencePath) || !fs.statSync(evidencePath).isFile()) {
    fail(`${MATRIX_PATH}: fixture ${fixture.id} evidence file does not exist: ${evidencePath}`);
  }
  const text = readText(evidencePath);
  for (const marker of evidence.markers) {
    if (!text.includes(marker)) {
      fail(
        `${MATRIX_PATH}: fixture ${fixture.id} evidence file ${evidence.path} ` +
          `for ${evidence.consumer} lacks marker ${JSON.stringify(marker)}`,
      );
    }
  }
  return {
    consumer: evidence.consumer,
    kind: evidence.kind ?? 'fixture-file',
    path: evidence.path,
    markers: evidence.markers,
  };
}

function validateFixtureFile(entry) {
  const fixturePath = path.join(FIXTURES_ROOT, entry.path);
  if (!fs.existsSync(fixturePath) || !fs.statSync(fixturePath).isFile()) {
    fail(`missing shared fixture ${fixturePath}`);
  }

  if (entry.format === 'json') {
    const parsed = JSON.parse(readText(fixturePath));
    if (!isPlainObject(parsed)) {
      fail(`${fixturePath}: JSON fixture must be an object`);
    }
  } else if (entry.format === 'properties') {
    validateProperties(fixturePath);
  } else if (entry.format === 'tsv') {
    validateTsv(fixturePath);
  }

  return {
    id: entry.id,
    path: `src/shared/fixtures/${entry.path}`,
    format: entry.format,
    proofOwner: entry.proof_owner,
    ciTier: entry.ci_tier,
    consumers: entry.consumers,
    nonConsumers: entry.non_consumers,
    shared: entry.shared,
    evidence: entry.evidence.map((evidence) => validateEvidenceFile(entry, evidence)),
  };
}

function loadProjectRoots() {
  const roots = { ...PROJECT_ROOTS };
  for (const [root, projectId] of Object.entries(PROJECT_ROOTS)) {
    const moonFile = path.join(ROOT, root, 'moon.yml');
    if (!fs.existsSync(moonFile) || !fs.statSync(moonFile).isFile()) {
      fail(`${MATRIX_PATH}: fixture matrix project root ${root} is missing moon.yml`);
    }
    const match = readText(moonFile).match(/^id:\s*["']?([^"'\s#]+)/mu);
    if (match === null) {
      fail(`${MATRIX_PATH}: fixture matrix project root ${root} moon.yml has no id`);
    }
    const actualProjectId = match[1];
    if (actualProjectId !== projectId) {
      fail(`${MATRIX_PATH}: fixture matrix project root ${root} expected id ${projectId}, got ${actualProjectId}`);
    }
  }
  return roots;
}

function projectForPath(file, projectRoots) {
  const relative = posixRelative(file);
  let bestRoot = '';
  let bestProject = null;
  for (const [root, projectId] of Object.entries(projectRoots)) {
    if (relative === root || relative.startsWith(`${root}/`)) {
      if (root.length > bestRoot.length) {
        bestRoot = root;
        bestProject = projectId;
      }
    }
  }
  return bestProject;
}

function validateProjectIds(entries, projectRoots) {
  const knownIds = new Set(Object.values(projectRoots));
  for (const entry of entries) {
    const ids = new Set([
      ...entry.consumers,
      ...entry.non_consumers,
      ...entry.evidence.map((evidence) => evidence.consumer),
    ]);
    const unknown = [...ids].filter((id) => !knownIds.has(id)).sort();
    if (unknown.length > 0) {
      fail(`${MATRIX_PATH}: fixture ${entry.id} references unknown Moon project ids: ${JSON.stringify(unknown)}`);
    }
  }
}

function* walkFiles(root) {
  if (!fs.existsSync(root)) {
    return;
  }
  const entries = fs.readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIR_NAMES.has(entry.name)) {
        yield* walkFiles(file);
      }
      continue;
    }
    if (entry.isFile()) {
      yield file;
    }
  }
}

function detectFixtureReferences(entries, projectRoots) {
  const byPattern = new Map();
  for (const entry of entries) {
    byPattern.set(`src/shared/fixtures/${entry.path}`, entry);
    byPattern.set(entry.path, entry);
  }

  const detections = [];
  const seen = new Set();
  for (const scanRoot of CONSUMPTION_SCAN_ROOTS) {
    for (const file of walkFiles(path.join(ROOT, scanRoot))) {
      if (!CODE_SUFFIXES.has(path.extname(file))) {
        continue;
      }
      const relativeParts = posixRelative(file).split('/');
      if (relativeParts.some((part) => IGNORED_DIR_NAMES.has(part))) {
        continue;
      }
      let text;
      try {
        text = readText(file);
      } catch (error) {
        if (error instanceof TypeError) {
          continue;
        }
        throw error;
      }
      for (const [pattern, entry] of byPattern.entries()) {
        if (!text.includes(pattern)) {
          continue;
        }
        const projectId = projectForPath(file, projectRoots);
        if (projectId === null) {
          fail(`${MATRIX_PATH}: fixture reference in unmanaged path ${posixRelative(file)}`);
        }
        if (entry.non_consumers.includes(projectId) || !entry.consumers.includes(projectId)) {
          fail(
            `${MATRIX_PATH}: ${projectId} references fixture ${entry.id} from ${posixRelative(file)}, ` +
              `but allowed consumers are ${JSON.stringify(entry.consumers)}`,
          );
        }
        const detectionKey = `${entry.id}\0${projectId}\0${posixRelative(file)}`;
        if (seen.has(detectionKey)) {
          continue;
        }
        seen.add(detectionKey);
        detections.push({
          fixtureId: entry.id,
          project: projectId,
          path: posixRelative(file),
          matched: pattern,
        });
      }
    }
  }
  return detections;
}

function writeConsumptionReport(entries, detections) {
  const detectionsByFixture = new Map(entries.map((entry) => [entry.id, []]));
  for (const detection of detections) {
    if (!detectionsByFixture.has(detection.fixtureId)) {
      detectionsByFixture.set(detection.fixtureId, []);
    }
    detectionsByFixture.get(detection.fixtureId).push(detection);
  }

  const report = {
    schemaVersion: 1,
    fixtures: entries.map((entry) => ({
      id: entry.id,
      path: `src/shared/fixtures/${entry.path}`,
      consumers: entry.consumers,
      evidence: entry.evidence.map((evidence) => ({
        consumer: evidence.consumer,
        kind: evidence.kind ?? 'fixture-file',
        path: evidence.path,
      })),
      detectedReferences: detectionsByFixture.get(entry.id) ?? [],
    })),
  };
  fs.mkdirSync(path.dirname(GENERATED_CONSUMPTION_REPORT), { recursive: true });
  fs.writeFileSync(GENERATED_CONSUMPTION_REPORT, stableJson(report), 'utf8');
}

function parseArgs(argv) {
  let fixtures = false;
  for (const arg of argv) {
    if (arg === '--fixtures') {
      fixtures = true;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return { fixtures };
}

const args = parseArgs(Bun.argv.slice(2));
const matrix = loadMatrix();
if (matrix.schema_version !== 1) {
  fail(`${MATRIX_PATH}: schema_version must be 1`);
}
const rawFixtures = matrix.fixtures;
if (!Array.isArray(rawFixtures) || rawFixtures.length === 0) {
  fail(`${MATRIX_PATH}: must declare at least one [[fixtures]] entry`);
}

const seen = new Set();
const entries = rawFixtures.map((entry) => validateFixtureEntry(entry, seen));

if (args.fixtures) {
  const projectRoots = loadProjectRoots();
  validateProjectIds(entries, projectRoots);
  const detections = detectFixtureReferences(entries, projectRoots);
  const generated = {
    schemaVersion: 1,
    fixtures: entries.map(validateFixtureFile),
  };
  fs.mkdirSync(path.dirname(GENERATED_MANIFEST), { recursive: true });
  fs.writeFileSync(GENERATED_MANIFEST, stableJson(generated), 'utf8');
  writeConsumptionReport(entries, detections);
}

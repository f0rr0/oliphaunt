import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(hostDirectory, '../../../..');
const sourceManifestPath = 'src/bindings/wasix-ts/host/source.toml';
const buildScriptPath = 'src/bindings/wasix-ts/host/build-sdk.sh';
const provenanceScriptPath = 'src/bindings/wasix-ts/host/build-provenance.mjs';
const safePatchName = /^\d{4}-wasmer-(?:(?:js|wasix)-)?[a-z0-9-]+\.patch$/u;

export async function loadHostBuildContract() {
  const source = await readFile(resolve(repositoryRoot, sourceManifestPath), 'utf8');
  const patchSeries = tomlStringArray(source, 'patches', 'series');
  if (patchSeries.length === 0 || new Set(patchSeries).size !== patchSeries.length) {
    throw new Error('WASIX host patch series must be non-empty and unique');
  }
  for (const patch of patchSeries) {
    if (!safePatchName.test(patch)) {
      throw new Error(`WASIX host patch name is unsafe: ${JSON.stringify(patch)}`);
    }
  }

  const inputs = Object.freeze([
    sourceManifestPath,
    ...patchSeries.map((patch) => `src/bindings/wasix-ts/host/patches/${patch}`),
    buildScriptPath,
    provenanceScriptPath,
  ]);
  const digests = [];
  for (const input of inputs) {
    const bytes = await readFile(resolve(repositoryRoot, input));
    digests.push(`${sha256(bytes)}\n`);
  }

  const provenance = deepFreeze({
    wasmerJsCommit: tomlString(source, 'wasmer-js', 'commit'),
    wasmerWasixVersion: tomlString(source, 'wasmer-wasix', 'version'),
    inputsSha256: sha256(digests.join('')),
    guestConcurrency: 'denied-for-oliphaunt-single-backend',
    optimization: {
      cargoProfile: 'release',
      rustOptLevel: 3,
      lto: true,
      wasmOpt: ['--enable-threads', '--enable-bulk-memory', '-O3'],
    },
  });
  return Object.freeze({ inputs, patchSeries: Object.freeze(patchSeries), provenance });
}

function tomlString(source, section, key) {
  const body = tomlSection(source, section);
  const match = body.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]+)"\\s*$`, 'mu'));
  if (match === null) {
    throw new Error(`WASIX host source manifest is missing [${section}].${key}`);
  }
  return match[1];
}

function tomlStringArray(source, section, key) {
  const body = tomlSection(source, section);
  const match = body.match(
    new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*$`, 'mu'),
  );
  if (match === null) {
    throw new Error(`WASIX host source manifest is missing [${section}].${key}`);
  }
  const values = [];
  const item = /"([^"]+)"\s*,?/gu;
  for (const entry of match[1].matchAll(item)) values.push(entry[1]);
  const residue = match[1].replace(item, '').replace(/#[^\n]*/gu, '').trim();
  if (residue !== '') {
    throw new Error(`WASIX host source manifest has malformed [${section}].${key}`);
  }
  return values;
}

function tomlSection(source, section) {
  const escaped = escapeRegExp(section);
  const match = source.match(
    new RegExp(`^\\[${escaped}\\][ \\t]*\\r?\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'mu'),
  );
  if (match === null) throw new Error(`WASIX host source manifest is missing [${section}]`);
  return match[1];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const contract = await loadHostBuildContract();
  if (process.argv[2] === '--inputs-sha256') {
    console.log(contract.provenance.inputsSha256);
  } else if (process.argv[2] === '--patch-series') {
    console.log(contract.patchSeries.join('\n'));
  } else if (process.argv[2] === '--json') {
    console.log(JSON.stringify(contract.provenance, null, 2));
  } else {
    throw new Error('usage: build-provenance.mjs --inputs-sha256|--patch-series|--json');
  }
}

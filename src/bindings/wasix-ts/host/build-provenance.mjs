import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(hostDirectory, '../../../..');
const sourceManifestPath = 'src/bindings/wasix-ts/host/source.toml';
const buildScriptPath = 'src/bindings/wasix-ts/host/build-sdk.sh';
const provenanceScriptPath = 'src/bindings/wasix-ts/host/build-provenance.mjs';
const protocolTransportContractPath =
  'src/shared/postgres-protocol-transport-contract/contract.json';
const toolOutputContractPath = 'src/shared/postgres-tool-output-contract/contract.json';
const safePatchName = /^\d{4}-(?:wasmer(?:(?:-js|-wasix))?|virtual-fs)-[a-z0-9-]+\.patch$/u;

export async function loadHostBuildContract() {
  const source = await readFile(resolve(repositoryRoot, sourceManifestPath), 'utf8');
  const protocolTransportContractBytes = await readFile(
    resolve(repositoryRoot, protocolTransportContractPath),
  );
  const protocolTransportContract = JSON.parse(
    protocolTransportContractBytes.toString('utf8'),
  );
  validateProtocolTransportContract(protocolTransportContract);
  const toolOutputContract = JSON.parse(
    await readFile(resolve(repositoryRoot, toolOutputContractPath), 'utf8'),
  );
  validateToolOutputContract(toolOutputContract);
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
    protocolTransportContractPath,
    toolOutputContractPath,
  ]);
  const digests = [];
  for (const input of inputs) {
    const bytes = await readFile(resolve(repositoryRoot, input));
    digests.push(`${sha256(bytes)}\n`);
  }

  const provenance = deepFreeze({
    wasmerJsCommit: tomlString(source, 'wasmer-js', 'commit'),
    wasmerWasixVersion: tomlString(source, 'wasmer-wasix', 'version'),
    virtualFsVersion: tomlString(source, 'virtual-fs', 'version'),
    inputsSha256: sha256(digests.join('')),
    guestConcurrency: 'typed-single-program-host-policy',
    clockDispatch: 'server-direct-js-canonical-fallback-16ms-or-1024-reads-tools-canonical',
    fdClose: 'typed-filesystem-durability-policy',
    syncFilesystemBridge: 'realm-local-fresh-owned-js-transfer',
    toolProtocolWrite: 'owned-js-copy-before-callback',
    protocolTransport: {
      schema: protocolTransportContract.schema,
      contractSha256: sha256(protocolTransportContractBytes),
      modes: Object.fromEntries(
        protocolTransportContract.modes.map(({ name, value }) => [name, value]),
      ),
      bufferedOutputLimitBytes: protocolTransportContract.bufferedOutput.limitBytes,
      callbackChunkMaxBytes: protocolTransportContract.streamedOutput.callbackChunkMaxBytes,
      flushWasmResult: protocolTransportContract.flush.wasmResult,
    },
    toolOutputCapture: {
      schema: toolOutputContract.schema,
      limitBytes: toolOutputContract.capturedOutputLimitBytes,
      scope: toolOutputContract.scope,
      belowLimit: toolOutputContract.belowLimit,
      overflow: toolOutputContract.overflow,
      streamingEscapeHatch: toolOutputContract.streamingEscapeHatch,
    },
    randomDevice: 'virtual-fs-checked-getrandom',
    optimization: {
      cargoProfile: 'release',
      rustOptLevel: 3,
      lto: true,
      wasmOpt: ['--enable-threads', '--enable-bulk-memory', '-O3'],
    },
  });
  return Object.freeze({ inputs, patchSeries: Object.freeze(patchSeries), provenance });
}

function validateProtocolTransportContract(contract) {
  const modes = contract?.modes;
  if (
    contract?.schema !== 'oliphaunt-wasix-postgres-protocol-transport-contract-v1' ||
    !Array.isArray(modes) ||
    modes.length !== 4 ||
    modes.some(
      (mode) =>
        typeof mode?.name !== 'string' ||
        !Number.isSafeInteger(mode.value) ||
        mode.value < 0,
    ) ||
    new Set(modes.map(({ name }) => name)).size !== modes.length ||
    new Set(modes.map(({ value }) => value)).size !== modes.length ||
    !Number.isSafeInteger(contract.bufferedOutput?.limitBytes) ||
    contract.bufferedOutput.limitBytes <= 0 ||
    !Number.isSafeInteger(contract.streamedOutput?.callbackChunkMaxBytes) ||
    contract.streamedOutput.callbackChunkMaxBytes <= 0 ||
    contract.flush?.wasmResult !== 'i32'
  ) {
    throw new Error(
      `invalid PostgreSQL protocol transport contract: ${protocolTransportContractPath}`,
    );
  }
}

function validateToolOutputContract(contract) {
  if (
    contract?.schema !== 'oliphaunt-postgres-tool-output-contract-v1' ||
    !Number.isSafeInteger(contract.capturedOutputLimitBytes) ||
    contract.capturedOutputLimitBytes <= 0 ||
    contract.scope !== 'stdout-and-stderr-aggregate-per-process' ||
    contract.belowLimit !== 'preserve-exact-bytes' ||
    contract.overflow !== 'fail-closed-without-returning-partial-output' ||
    contract.streamingEscapeHatch !== 'required-for-larger-valid-output'
  ) {
    throw new Error(`invalid PostgreSQL tool output contract: ${toolOutputContractPath}`);
  }
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
  } else if (process.argv[2] === '--tool-output-limit-bytes') {
    console.log(contract.provenance.toolOutputCapture.limitBytes);
  } else if (process.argv[2] === '--json') {
    console.log(JSON.stringify(contract.provenance, null, 2));
  } else {
    throw new Error(
      'usage: build-provenance.mjs --inputs-sha256|--patch-series|--tool-output-limit-bytes|--json',
    );
  }
}

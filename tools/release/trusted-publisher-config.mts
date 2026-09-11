#!/usr/bin/env bun

import { randomUUID } from 'node:crypto';
import { link, lstat, open, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { ROOT } from './release-graph.mts';
import { validateNpmTrustCliRuntime } from './npm-trusted-publishing-runtime.mts';
import {
  DEFAULT_PUBLICATION_LOCK,
  loadPublicationLock,
  lockedCarriers,
} from './publication-lock.mts';
import { registryRetryDelaySeconds, registryStatusRetryable } from './registry-http-retry.mts';

export const TRUSTED_PUBLISHER_PLAN_SCHEMA = 'oliphaunt-trusted-publisher-plan-v1';
export const TRUSTED_PUBLISHER_REPORT_SCHEMA = 'oliphaunt-trusted-publisher-report-v1';
export const NPM_TRUST_BATCH_SIZE = 25;
export const CRATES_IO_TRUST_REQUEST_SPACING_MS = 250;

export const EXPECTED_TRUSTED_PUBLISHER = Object.freeze({
  repository: 'f0rr0/oliphaunt',
  repositoryOwner: 'f0rr0',
  repositoryName: 'oliphaunt',
  workflowFilename: 'release.yml',
  environment: 'release-publish',
  npmPermissions: Object.freeze(['createPackage']),
});

const CRATES_IO_CONFIG_ENDPOINT = 'https://crates.io/api/v1/trusted_publishing/github_configs';
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_READ_ATTEMPTS = 3;

function error(message) {
  return new Error(`trusted-publisher-config: ${message}`);
}

function compareText(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function selectedProducts(lock, products) {
  if (products === undefined) return undefined;
  if (
    !Array.isArray(products) ||
    products.length === 0 ||
    products.some((product) => typeof product !== 'string' || product.length === 0) ||
    new Set(products).size !== products.length
  ) {
    throw error('products must be a non-empty unique string list');
  }
  const known = new Set(lock.products.map(({ id }) => id));
  const unknown = products.filter((product) => !known.has(product));
  if (unknown.length > 0)
    throw error(`products are absent from the exact lock: ${unknown.join(', ')}`);
  return new Set(products);
}

function batchRows(identities, size = NPM_TRUST_BATCH_SIZE) {
  const batches = [];
  for (let start = 0; start < identities.length; start += size) {
    const rows = identities.slice(start, start + size);
    batches.push({
      number: batches.length + 1,
      count: rows.length,
      first: rows[0].id,
      last: rows.at(-1).id,
    });
  }
  return batches;
}

export function buildTrustedPublisherPlan(lock, { products = undefined } = {}) {
  const selected = selectedProducts(lock, products);
  const identities = lockedCarriers(lock)
    .filter((carrier) => selected === undefined || selected.has(carrier.product))
    .filter((carrier) => carrier.ecosystem === 'cargo' || carrier.ecosystem === 'npm')
    .map(({ id, ecosystem, name, product, version }) => ({ id, ecosystem, name, product, version }))
    .sort((left, right) => compareText(left.id, right.id));
  const unique = new Set(identities.map(({ id }) => id));
  if (unique.size !== identities.length)
    throw error('exact lock contains duplicate npm/Cargo identities');
  const npm = identities.filter(({ ecosystem }) => ecosystem === 'npm');
  const cargo = identities.filter(({ ecosystem }) => ecosystem === 'cargo');
  return {
    schema: TRUSTED_PUBLISHER_PLAN_SCHEMA,
    lockDigest: lock.lockDigest,
    catalogDigest: lock.catalogDigest,
    source: lock.source,
    products: lock.products
      .filter(({ id }) => selected === undefined || selected.has(id))
      .map(({ id, version }) => ({ id, version })),
    expected: EXPECTED_TRUSTED_PUBLISHER,
    counts: { cargo: cargo.length, npm: npm.length, total: identities.length },
    npmBatchSize: NPM_TRUST_BATCH_SIZE,
    npmBatches: batchRows(npm),
    identities,
  };
}

export function selectTrustedPublisherIdentities(plan, ecosystem, batch = undefined) {
  if (ecosystem !== 'cargo' && ecosystem !== 'npm') {
    throw error('--ecosystem must be cargo or npm for audit/apply');
  }
  const identities = plan.identities.filter((identity) => identity.ecosystem === ecosystem);
  if (identities.length === 0) throw error(`exact lock selects no ${ecosystem} identities`);
  if (ecosystem === 'cargo') {
    if (batch !== undefined) throw error("--batch is used only for npm's bounded 2FA windows");
    return { identities, batch: null, batches: 1 };
  }
  const batches = batchRows(identities);
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > batches.length) {
    throw error(`npm audit/apply requires --batch N from 1 through ${batches.length}`);
  }
  const start = (batch - 1) * NPM_TRUST_BATCH_SIZE;
  return {
    identities: identities.slice(start, start + NPM_TRUST_BATCH_SIZE),
    batch,
    batches: batches.length,
  };
}

function relevantNpmConfig(config) {
  return {
    type: config?.type ?? null,
    repository: config?.repository ?? null,
    file: config?.file ?? null,
    environment: config?.environment ?? null,
    permissions: Array.isArray(config?.permissions)
      ? [...config.permissions].sort(compareText)
      : null,
  };
}

function relevantCratesConfig(config) {
  return {
    crate: config?.crate ?? null,
    repository_owner: config?.repository_owner ?? null,
    repository_name: config?.repository_name ?? null,
    workflow_filename: config?.workflow_filename ?? null,
    environment: config?.environment ?? null,
  };
}

function exactNpmConfig(config) {
  const expected = {
    type: 'github',
    repository: EXPECTED_TRUSTED_PUBLISHER.repository,
    file: EXPECTED_TRUSTED_PUBLISHER.workflowFilename,
    environment: EXPECTED_TRUSTED_PUBLISHER.environment,
    permissions: [...EXPECTED_TRUSTED_PUBLISHER.npmPermissions],
  };
  return stableJson(relevantNpmConfig(config)) === stableJson(expected);
}

function exactCratesConfig(config, name) {
  const expected = {
    crate: name,
    repository_owner: EXPECTED_TRUSTED_PUBLISHER.repositoryOwner,
    repository_name: EXPECTED_TRUSTED_PUBLISHER.repositoryName,
    workflow_filename: EXPECTED_TRUSTED_PUBLISHER.workflowFilename,
    environment: EXPECTED_TRUSTED_PUBLISHER.environment,
  };
  return stableJson(relevantCratesConfig(config)) === stableJson(expected);
}

export function classifyNpmTrustConfigs(configs) {
  if (!Array.isArray(configs))
    throw error('npm trust list output must be a JSON object, array, or empty output');
  if (configs.length === 0) return { state: 'missing' };
  if (configs.length === 1 && exactNpmConfig(configs[0])) return { state: 'exact' };
  return {
    state: 'conflict',
    reason: `expected exactly one publish-only GitHub configuration; observed ${JSON.stringify(configs.map(relevantNpmConfig))}`,
  };
}

export function classifyCratesIoTrustConfigs(configs, name) {
  if (!Array.isArray(configs)) throw error('crates.io github_configs must be an array');
  if (configs.length === 0) return { state: 'missing' };
  if (configs.length === 1 && exactCratesConfig(configs[0], name)) return { state: 'exact' };
  return {
    state: 'conflict',
    reason: `expected exactly one GitHub configuration; observed ${JSON.stringify(configs.map(relevantCratesConfig))}`,
  };
}

function parseNpmJson(text, context) {
  const value = text.trim();
  if (value === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw error(`${context} returned invalid JSON`);
  }
  return Array.isArray(parsed) ? parsed : [parsed];
}

function npmPackageName(name) {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > 214 ||
    /[\u0000-\u0020\u007f]/u.test(name) ||
    !/^@oliphaunt\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(name)
  ) {
    throw error('npm package name must be a canonical bounded @oliphaunt identity');
  }
  return name;
}

function safeToken(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 16 * 1024 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw error('CRATES_IO_TRUST_CONFIG_TOKEN must be a non-empty control-free secret');
  }
  return value;
}

async function boundedText(response, context) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel?.().catch(() => {});
    throw error(`${context} response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  const reader = response.body?.getReader?.();
  if (reader === undefined) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES)
      throw error(`${context} response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    return text;
  }
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw error(`${context} response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function responseJson(response, context) {
  const text = await boundedText(response, context);
  if (!response.ok) throw error(`${context} returned HTTP ${response.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw error(`${context} returned invalid JSON`);
  }
}

function requestSignal() {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

export function createCratesIoTrustClient({
  token = process.env.CRATES_IO_TRUST_CONFIG_TOKEN,
  fetchImpl = fetch,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const secret = safeToken(token);
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${secret}`,
    'User-Agent': 'oliphaunt-trust-config/1; https://github.com/f0rr0/oliphaunt',
  };
  return {
    async list(name) {
      const url = new URL(CRATES_IO_CONFIG_ENDPOINT);
      url.searchParams.set('crate', name);
      url.searchParams.set('per_page', '100');
      let lastError;
      for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
        try {
          const response = await fetchImpl(url, {
            method: 'GET',
            headers,
            redirect: 'error',
            signal: requestSignal(),
          });
          if (registryStatusRetryable(response.status) && attempt + 1 < MAX_READ_ATTEMPTS) {
            const seconds = registryRetryDelaySeconds({ headers: response.headers, attempt });
            await boundedText(response, `crates.io trust audit for ${name}`);
            await sleepImpl(seconds * 1_000);
            continue;
          }
          const body = await responseJson(response, `crates.io trust audit for ${name}`);
          if (!Array.isArray(body?.github_configs))
            throw error(`crates.io trust audit for ${name} omitted github_configs`);
          if (body.github_configs.length > 5)
            throw error(
              `crates.io trust audit for ${name} exceeded the registry's five-config limit`,
            );
          return body.github_configs;
        } catch (cause) {
          lastError = cause;
          if (
            attempt + 1 >= MAX_READ_ATTEMPTS ||
            !(cause?.name === 'TimeoutError' || cause instanceof TypeError)
          )
            throw cause;
          await sleepImpl(registryRetryDelaySeconds({ attempt }) * 1_000);
        }
      }
      throw lastError;
    },
    async create(name) {
      const response = await fetchImpl(CRATES_IO_CONFIG_ENDPOINT, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          github_config: {
            crate: name,
            repository_owner: EXPECTED_TRUSTED_PUBLISHER.repositoryOwner,
            repository_name: EXPECTED_TRUSTED_PUBLISHER.repositoryName,
            workflow_filename: EXPECTED_TRUSTED_PUBLISHER.workflowFilename,
            environment: EXPECTED_TRUSTED_PUBLISHER.environment,
          },
        }),
        redirect: 'error',
        signal: requestSignal(),
      });
      const body = await responseJson(response, `crates.io trust creation for ${name}`);
      if (!exactCratesConfig(body?.github_config, name)) {
        throw error(`crates.io created an unexpected trusted-publisher configuration for ${name}`);
      }
    },
  };
}

async function auditIdentities({ identities, client, spacingMs, sleepImpl, progress }) {
  const results = [];
  for (const [index, identity] of identities.entries()) {
    const configs = await client.list(identity.name);
    const classified = classifyCratesIoTrustConfigs(configs, identity.name);
    results.push({ id: identity.id, ...classified });
    progress?.(`audit ${index + 1}/${identities.length} ${identity.id}: ${classified.state}`);
    await sleepImpl(spacingMs);
  }
  return results;
}

function reportEnvelope({
  plan,
  selection,
  ecosystem,
  mode,
  initial,
  final = initial,
  created = [],
}) {
  const states = (rows, state) => rows.filter((row) => row.state === state).map(({ id }) => id);
  return {
    schema: TRUSTED_PUBLISHER_REPORT_SCHEMA,
    mode,
    ecosystem,
    lockDigest: plan.lockDigest,
    catalogDigest: plan.catalogDigest,
    selection: {
      count: selection.identities.length,
      batch: selection.batch,
      batches: selection.batches,
    },
    exact: states(final, 'exact'),
    missing: states(final, 'missing'),
    conflicts: final
      .filter(({ state }) => state === 'conflict')
      .map(({ id, reason }) => ({ id, reason })),
    created,
    initial: {
      exact: states(initial, 'exact').length,
      missing: states(initial, 'missing').length,
      conflicts: states(initial, 'conflict').length,
    },
  };
}

export async function reconcileTrustedPublishers({
  plan,
  ecosystem,
  batch = undefined,
  apply = false,
  client,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  progress = undefined,
} = {}) {
  const selection = selectTrustedPublisherIdentities(plan, ecosystem, batch);
  if (ecosystem !== 'cargo')
    throw error('npm configuration commands belong to trusted-publisher-config.sh');
  const spacingMs = CRATES_IO_TRUST_REQUEST_SPACING_MS;
  const initial = await auditIdentities({
    ...selection,
    ecosystem,
    client,
    spacingMs,
    sleepImpl,
    progress,
  });
  if (!apply || initial.some(({ state }) => state === 'conflict')) {
    return reportEnvelope({
      plan,
      selection,
      ecosystem,
      mode: apply ? 'apply-blocked' : 'audit',
      initial,
    });
  }
  const missing = new Set(initial.filter(({ state }) => state === 'missing').map(({ id }) => id));
  const created = [];
  for (const identity of selection.identities.filter(({ id }) => missing.has(id))) {
    let mutationFailure;
    try {
      await client.create(identity.name);
    } catch (cause) {
      mutationFailure = cause;
    }
    // A management request can be applied remotely even when its response is
    // lost. Never replay it here: inspect the exact immutable configuration,
    // accept only the desired state, and let a later invocation resume if the
    // registry still reports absence.
    await sleepImpl(spacingMs);
    const reconciledConfigs = await client.list(identity.name);
    const reconciled = classifyCratesIoTrustConfigs(reconciledConfigs, identity.name);
    if (reconciled.state !== 'exact') {
      if (mutationFailure !== undefined) throw mutationFailure;
      throw error(
        `${identity.id} trusted-publisher mutation returned without the exact configuration becoming observable` +
          `${reconciled.reason ? `: ${reconciled.reason}` : ''}`,
      );
    }
    created.push(identity.id);
    progress?.(
      `${mutationFailure === undefined ? 'created' : 'reconciled'} ${created.length}/${missing.size} ${identity.id}`,
    );
    await sleepImpl(spacingMs);
  }
  const final = await auditIdentities({
    ...selection,
    ecosystem,
    client,
    spacingMs,
    sleepImpl,
    progress,
  });
  return reportEnvelope({ plan, selection, ecosystem, mode: 'apply', initial, final, created });
}

function parseArgs(argv) {
  const allowedValues = new Set([
    'lock',
    'products-json',
    'ecosystem',
    'batch',
    'confirm-lock-digest',
    'output',
  ]);
  const values = new Map();
  const booleans = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply' || arg === '--audit' || arg === '--help' || arg === '-h') {
      booleans.add(arg.replace(/^-+/u, ''));
      continue;
    }
    if (!arg.startsWith('--')) throw error(`unexpected positional argument ${arg}`);
    const separator = arg.indexOf('=');
    const key = arg.slice(2, separator === -1 ? undefined : separator);
    if (!allowedValues.has(key)) throw error(`unknown argument --${key}`);
    const value = separator === -1 ? argv[++index] : arg.slice(separator + 1);
    if (value === undefined || value.length === 0) throw error(`--${key} requires a value`);
    if (values.has(key)) throw error(`--${key} may be specified only once`);
    values.set(key, value);
  }
  return { values, booleans };
}

function productsValue(raw) {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw error('--products-json must be strict JSON');
  }
}

function usage() {
  return [
    'usage:',
    '  trusted-publisher-config.sh [--lock FILE] [--products-json JSON] [--output FILE]',
    '  trusted-publisher-config.sh --audit --ecosystem cargo|npm [--batch N] [--lock FILE] [--products-json JSON] [--output FILE]',
    '  trusted-publisher-config.sh --apply --confirm-lock-digest SHA256 --ecosystem cargo|npm [--batch N] [--lock FILE] [--products-json JSON] [--output FILE]',
    '',
    'No --audit/--apply: print an exact-lock plan without registry authentication or network access.',
    '--audit: authenticated read-only comparison. --apply: create only missing exact configs, then re-audit.',
    'npm requires deterministic batches sized for its documented five-minute 2FA window.',
    'Run npm audit/apply directly in an interactive terminal; a read-only warm-up authenticates each audit pass.',
    'npm audit/apply requires --output FILE; the report is atomically created with mode 0600 and never overwritten.',
  ].join('\n');
}

function prettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function writeJson(value, stream = process.stdout) {
  const output = prettyJson(value);
  await new Promise((resolve, reject) => {
    const onError = (cause) => {
      stream.off?.('error', onError);
      reject(cause);
    };
    stream.once?.('error', onError);
    stream.write(output, (cause) => {
      stream.off?.('error', onError);
      if (cause !== undefined && cause !== null) reject(cause);
      else resolve();
    });
  });
}

export async function reserveJsonFile(outputFile) {
  if (typeof outputFile !== 'string' || outputFile.length === 0) {
    throw error('--output must be a non-empty file path');
  }
  const destination = path.resolve(ROOT, outputFile);
  const reservation = `${destination}.oliphaunt-reservation`;
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.tmp-${process.pid}-${randomUUID()}`,
  );
  const probe = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.probe-${process.pid}-${randomUUID()}`,
  );
  let outputHandle;
  let reservationHandle;
  let reservationCreated = false;
  let probeLinked = false;
  try {
    reservationHandle = await open(reservation, 'wx', 0o600);
    reservationCreated = true;
    await reservationHandle.writeFile(
      `Oliphaunt trusted-publisher report reservation for ${destination}\n`,
      'utf8',
    );
    await reservationHandle.sync();
    await reservationHandle.close();
    reservationHandle = undefined;
    outputHandle = await open(temporary, 'wx', 0o600);
    try {
      await lstat(destination);
      const exists = new Error('destination exists');
      exists.code = 'EEXIST';
      throw exists;
    } catch (cause) {
      if (cause?.code !== 'ENOENT') throw cause;
    }
    // Exercise the exact no-overwrite atomic publication primitive before any
    // registry request. The deterministic reservation blocks cooperating
    // invocations while the final destination remains absent for publication.
    await link(temporary, probe);
    probeLinked = true;
    await unlink(probe);
    probeLinked = false;
  } catch (cause) {
    if (reservationHandle !== undefined) await reservationHandle.close().catch(() => {});
    if (outputHandle !== undefined) await outputHandle.close().catch(() => {});
    if (probeLinked) await unlink(probe).catch(() => {});
    await unlink(temporary).catch(() => {});
    if (reservationCreated) await unlink(reservation).catch(() => {});
    if (cause?.code === 'EEXIST') {
      if (!reservationCreated) {
        throw error(`--output reservation already exists for ${destination}`);
      }
      throw error(`refusing to overwrite existing --output file ${destination}`);
    }
    throw error(`could not reserve --output file ${destination}: ${cause?.message ?? cause}`);
  }
  let active = true;
  return {
    destination,
    async commit(value) {
      if (!active) throw error(`--output reservation is no longer active for ${destination}`);
      try {
        await outputHandle.writeFile(prettyJson(value), 'utf8');
        await outputHandle.sync();
        await outputHandle.close();
        outputHandle = undefined;
        await link(temporary, destination);
        active = false;
        await unlink(temporary).catch(() => {});
        await unlink(reservation).catch(() => {});
        return destination;
      } catch (cause) {
        if (cause?.code === 'EEXIST') {
          throw error(`refusing to overwrite existing --output file ${destination}`);
        }
        throw error(
          `could not publish reserved --output file ${destination}: ${cause?.message ?? cause}`,
        );
      }
    },
    async abort() {
      if (!active) return;
      active = false;
      if (outputHandle !== undefined) await outputHandle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      await unlink(reservation).catch(() => {});
    },
  };
}

export async function writeJsonFile(value, outputFile) {
  const reserved = await reserveJsonFile(outputFile);
  try {
    return await reserved.commit(value);
  } finally {
    await reserved.abort();
  }
}

async function emitJson(value, outputFile) {
  if (outputFile === undefined) {
    await writeJson(value);
    return;
  }
  const destination = await writeJsonFile(value, outputFile);
  console.error(`trusted-publisher-config: wrote exact JSON report to ${destination}`);
}

export async function reconcileTrustedPublishersToFile({ outputFile, ...options }) {
  const reserved = await reserveJsonFile(outputFile);
  try {
    const report = await reconcileTrustedPublishers(options);
    const destination = await reserved.commit(report);
    console.error(`trusted-publisher-config: wrote exact JSON report to ${destination}`);
    return report;
  } finally {
    await reserved.abort();
  }
}

async function main(argv, scratch) {
  const { values, booleans } = parseArgs(argv);
  if (booleans.has('help') || booleans.has('h')) {
    console.log(usage());
    return 0;
  }
  if (booleans.has('audit') && booleans.has('apply'))
    throw error('--audit and --apply are mutually exclusive');
  const lockFile = path.resolve(ROOT, values.get('lock') ?? DEFAULT_PUBLICATION_LOCK);
  const plan = buildTrustedPublisherPlan(loadPublicationLock(lockFile), {
    products: productsValue(values.get('products-json')),
  });
  if (!booleans.has('audit') && !booleans.has('apply')) {
    if (values.has('ecosystem') || values.has('batch') || values.has('confirm-lock-digest')) {
      throw error('--ecosystem, --batch, and --confirm-lock-digest require --audit or --apply');
    }
    await emitJson(plan, values.get('output'));
    return 0;
  }
  const ecosystem = values.get('ecosystem');
  const batch = values.has('batch') ? Number(values.get('batch')) : undefined;
  if (ecosystem === 'npm' && !values.has('output')) {
    throw error(
      'npm audit/apply requires --output FILE so TTY authentication cannot contaminate report evidence',
    );
  }
  if (booleans.has('apply')) {
    const confirmed = values.get('confirm-lock-digest');
    if (confirmed !== plan.lockDigest) {
      throw error(`--confirm-lock-digest must exactly equal ${plan.lockDigest}`);
    }
  } else if (values.has('confirm-lock-digest')) {
    throw error('--confirm-lock-digest is used only with --apply');
  }
  const selection = selectTrustedPublisherIdentities(plan, ecosystem, batch);
  if (ecosystem === 'npm') {
    if (!scratch)
      throw error(
        'npm audit/apply must run through bash tools/release/trusted-publisher-config.sh',
      );
    for (const identity of selection.identities) npmPackageName(identity.name);
    await writeFile(
      path.join(scratch, 'context.json'),
      prettyJson({
        plan: { lockDigest: plan.lockDigest, catalogDigest: plan.catalogDigest },
        selection,
        apply: booleans.has('apply'),
        output: path.resolve(ROOT, values.get('output')),
      }),
      { flag: 'wx', mode: 0o600 },
    );
    return 0;
  }
  const client = createCratesIoTrustClient();
  const reconcileOptions = {
    plan,
    ecosystem,
    batch,
    apply: booleans.has('apply'),
    client,
    progress: (line) => console.error(line),
  };
  let report;
  if (values.has('output')) {
    report = await reconcileTrustedPublishersToFile({
      ...reconcileOptions,
      outputFile: values.get('output'),
    });
  } else {
    report = await reconcileTrustedPublishers(reconcileOptions);
    await writeJson(report);
  }
  return report.missing.length === 0 && report.conflicts.length === 0 ? 0 : 1;
}

// npm owns its TTY and commands in Shell; these phases consume only captured data.
async function npmPhase(phase, scratch, index) {
  const read = async (file) => {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.size > MAX_RESPONSE_BYTES)
      throw error('invalid bounded npm trust evidence: ' + file);
    return await readFile(file, 'utf8');
  };
  if (phase === '--npm-runtime') {
    validateNpmTrustCliRuntime((await read(path.join(scratch, 'npm-version'))).trim());
    return;
  }
  const { plan, selection, apply, output } = JSON.parse(
    await read(path.join(scratch, 'context.json')),
  );
  if (phase === '--npm-commit') {
    const report = JSON.parse(await read(index));
    await link(index, output);
    console.error('trusted-publisher-config: wrote exact JSON report to ' + output);
    process.exitCode = report.missing.length === 0 && report.conflicts.length === 0 ? 0 : 1;
    return;
  }
  const classify = async (pass) =>
    await Promise.all(
      selection.identities.map(async ({ id }, number) => ({
        id,
        ...classifyNpmTrustConfigs(
          parseNpmJson(await read(path.join(scratch, pass + '-' + number)), id),
        ),
      })),
    );
  if (phase === '--npm-reconcile') {
    const identity = selection.identities[Number(index)];
    if (!identity) throw error('unknown npm trust identity');
    const row = classifyNpmTrustConfigs(
      parseNpmJson(await read(path.join(scratch, 'reconcile-' + index)), identity.id),
    );
    if (row.state !== 'exact')
      throw error(identity.id + ' trusted-publisher mutation did not reconcile: ' + row.state);
    await writeFile(path.join(scratch, 'created-' + index), identity.id, {
      flag: 'wx',
      mode: 0o600,
    });
    return;
  }
  const initial = await classify('initial');
  const blocked = initial.some((row) => row.state === 'conflict');
  if (phase === '--npm-initial') {
    const missing =
      !apply || blocked
        ? []
        : selection.identities.flatMap((identity, number) =>
            initial[number].state === 'missing' ? [number] : [],
          );
    await writeFile(path.join(scratch, 'missing.json'), prettyJson(missing));
    await writeFile(
      path.join(scratch, 'initial-report.json'),
      prettyJson(
        reportEnvelope({
          plan,
          selection,
          ecosystem: 'npm',
          mode: apply && blocked ? 'apply-blocked' : 'audit',
          initial,
        }),
      ),
    );
    return;
  }
  if (phase !== '--npm-report') throw error('unknown npm data phase ' + phase);
  const final = apply && !blocked ? await classify('final') : initial;
  const created = [];
  if (apply && !blocked) {
    for (const [number, identity] of selection.identities.entries()) {
      if (initial[number].state !== 'missing') continue;
      if ((await read(path.join(scratch, 'created-' + number))) !== identity.id)
        throw error('missing exact npm mutation receipt');
      created.push(identity.id);
    }
  }
  await writeJson(
    reportEnvelope({
      plan,
      selection,
      ecosystem: 'npm',
      mode: !apply ? 'audit' : blocked ? 'apply-blocked' : 'apply',
      initial,
      final,
      created,
    }),
  );
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args[0]?.startsWith('--npm-')) await npmPhase(...args);
    else if (args[0] === '--prepare') process.exitCode = await main(args.slice(2), args[1]);
    else process.exitCode = await main(args);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 2;
  }
}

import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createDeterministicTar } from '../packaging/cargo-source-package.mts';
import { consumerHostTarget, frozenConsumerPlan, runFrozenConsumers } from './frozen-consumer.mts';
import { normalPublicationPlan } from './normal-publication-plan.mts';
import { aggregateConsumerResults } from './publication-consumer-proof.mts';
import { buildPublicationCandidate, freezePublicationCandidate } from './publication-lock.mts';
import { ROOT } from './release-graph.mts';

function queryPackages(root, { missingCommonJS = false } = {}) {
  const artifacts = path.join(root, 'artifacts');
  mkdirSync(artifacts);
  const npm = JSON.parse(readFileSync(path.join(ROOT, 'src/query/ts/package.json'), 'utf8'));
  const directory = path.join(root, 'package');
  mkdirSync(directory);
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify(npm));
  const wire = `function simpleQuery(sql) { const text = new TextEncoder().encode(sql); const frame = new Uint8Array(text.length + 6); frame[0] = 81; new DataView(frame.buffer).setUint32(1, text.length + 5); frame.set(text, 5); return frame; }`;
  for (const mode of ['module', 'commonjs']) {
    const destination = path.join(directory, 'dist', mode);
    mkdirSync(destination, { recursive: true });
    writeFileSync(
      path.join(destination, 'package.json'),
      JSON.stringify({ type: mode === 'module' ? 'module' : 'commonjs' }),
    );
    writeFileSync(
      path.join(destination, 'protocol.js'),
      `${wire}\n${mode === 'module' ? 'export { simpleQuery };' : 'exports.simpleQuery = simpleQuery;'}`,
    );
    if (mode !== 'commonjs' || !missingCommonJS)
      writeFileSync(
        path.join(destination, 'query.js'),
        mode === 'module'
          ? 'import {simpleQuery} from "./protocol.js"; export const postgresOids = {int4: 23}; export const structuredSimpleQuery = simpleQuery;'
          : 'exports.postgresOids = {int4: 23}; exports.structuredSimpleQuery = require("./protocol.js").simpleQuery;',
      );
  }
  writeFileSync(
    path.join(artifacts, 'query.tgz'),
    gzipSync(createDeterministicTar(directory, 'package', {})),
  );
  const manifest = readFileSync(path.join(ROOT, 'src/query/rust/Cargo.toml'), 'utf8');
  const version = Bun.TOML.parse(manifest).package.version;
  const crate = path.join(root, `oliphaunt-query-${version}`);
  mkdirSync(path.join(crate, 'src'), { recursive: true });
  writeFileSync(
    path.join(crate, 'Cargo.toml'),
    `[package]\nname="oliphaunt-query"\nversion="${version}"\nedition="2024"\n`,
  );
  writeFileSync(path.join(crate, 'src/lib.rs'), 'pub const ANSWER: i32 = 42;\n');
  writeFileSync(
    path.join(artifacts, 'query.crate'),
    gzipSync(createDeterministicTar(crate, path.basename(crate), {})),
  );
  return artifacts;
}

test('real resolvers consume a frozen mixed candidate; missing exports and changed bytes fail closed', async () => {
  mkdirSync(path.join(ROOT, 'target'), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, 'target/frozen-pipeline-'));
  const originalFetch = globalThis.fetch;
  // The resolver uses real local HTTP and archives; public packuments are deterministic fixtures.
  globalThis.fetch = (input, init) =>
    String(input).startsWith('https://registry.npmjs.org/')
      ? Promise.resolve(new Response('', { status: 404 }))
      : originalFetch(input, init);
  try {
    const good = path.join(root, 'good');
    mkdirSync(good);
    const artifacts = queryPackages(good);
    const lock = freezePublicationCandidate(
      buildPublicationCandidate({
        products: ['oliphaunt-query', 'oliphaunt-query-ts'],
        artifactRoots: [artifacts],
      }),
    );
    const target = consumerHostTarget(
      `${process.platform}-${process.arch}${process.platform === 'win32' ? '-msvc' : process.platform === 'linux' ? '-gnu' : ''}`,
    );
    const output = path.join(root, 'results.json');
    const result = await runFrozenConsumers(lock, target, output);
    expect(result.cases.map((entry) => entry.status)).toEqual(['success', 'success']);
    expect(result.cases.map((entry) => entry.executionLevel)).toEqual([
      'compile-and-link',
      'execute',
    ]);
    for (const entry of result.cases) {
      const carrier = lock.carriers.find(({ id }) => id === entry.carrierId);
      expect(
        entry.resolvedInputs.some(
          (input) => input.identity === `${carrier.name}@${carrier.version}`,
        ),
      ).toBe(true);
    }
    expect(readFileSync(`${output}.logs/case-1/execute.log`, 'utf8')).toBe('');
    expect(
      normalPublicationPlan(
        lock,
        lock.products.map(({ id }) => id),
      ).carrierCount,
    ).toBe(2);
    const producer = {
      controllerSHA: 'c'.repeat(40),
      runId: 123,
      runAttempt: 1,
      jobName: `Frozen consumers (${target})`,
    };
    expect(() =>
      aggregateConsumerResults(
        frozenConsumerPlan(lock),
        [
          {
            ...result,
            cases: result.cases.map((entry) => ({ ...entry, producer })),
          },
        ],
        producer,
      ),
    ).toThrow('missing consumer cases');
    const broken = path.join(root, 'broken');
    mkdirSync(broken);
    const brokenLock = freezePublicationCandidate(
      buildPublicationCandidate({
        products: ['oliphaunt-query-ts'],
        artifactRoots: [queryPackages(broken, { missingCommonJS: true })],
      }),
    );
    const failedOutput = path.join(root, 'failed.json');
    await expect(runFrozenConsumers(brokenLock, target, failedOutput)).rejects.toThrow(
      'MODULE_NOT_FOUND',
    );
    expect(JSON.parse(readFileSync(failedOutput, 'utf8')).cases[0].status).toBe('failure');
    expect(readFileSync(`${failedOutput}.logs/case-0/execute.log`, 'utf8')).toContain(
      'MODULE_NOT_FOUND',
    );
    writeFileSync(path.join(artifacts, 'query.tgz'), 'substituted bytes');
    await expect(runFrozenConsumers(lock, target, path.join(root, 'changed.json'))).rejects.toThrow(
      'bytes do not match',
    );
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

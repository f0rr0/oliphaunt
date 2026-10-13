#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createCratesIoReadGate } from './registry-http-retry.mts';
import {
  materializeRegistryCarrierIntegrity,
  validateLockedRegistryReceipts,
  validateRegistryReceiptEvidence,
  verifyLockedCarrierIntegrity,
  verifyLockedRegistryIntegrity,
  verifyRegistryCarrierIntegrity,
  writeRegistryReceiptEvidence,
} from './registry-integrity.mts';

const ROOT = path.resolve(import.meta.dir, '../..');
const sha = (bytes, algorithm, encoding = 'hex') =>
  createHash(algorithm).update(bytes).digest(encoding);

test('historical Maven files come from the exact old POM and each companion is acquired once', async () => {
  const root = mkdtempSync(path.join('/tmp', 'historical-maven-'));
  const pom = (packaging) =>
    `<project><modelVersion>4.0.0</modelVersion><groupId>dev.example</groupId><artifactId>retired</artifactId><version>1.0.0</version><packaging>${packaging}</packaging><name>Retired</name><description>Historical package</description><url>https://example.org</url><licenses><license><name>MIT</name><url>https://example.org/license</url></license></licenses><developers><developer><name>Maintainer</name><url>https://example.org</url></developer></developers><scm><connection>scm:git:https://example.org/repo</connection><developerConnection>scm:git:ssh://example.org/repo</developerConnection><url>https://example.org/repo</url></scm></project>`;
  try {
    for (const packaging of ['pom', 'jar', 'aar', 'tar.gz']) {
      const names = [
        'retired-1.0.0.pom',
        ...(packaging === 'pom'
          ? []
          : [
              `retired-1.0.0.${packaging}`,
              'retired-1.0.0-sources.jar',
              'retired-1.0.0-javadoc.jar',
            ]),
      ];
      const requested = [];
      const result = await materializeRegistryCarrierIntegrity(
        {
          id: 'maven:dev.example:retired',
          product: 'fixture',
          ecosystem: 'maven',
          name: 'dev.example:retired',
          version: '1.0.0',
          artifacts: [],
        },
        {
          directory: path.join(root, packaging),
          fetchImpl: async (url) => {
            const name = new URL(url).pathname.split('/').at(-1);
            assert.ok(names.includes(name));
            requested.push(name);
            return new Response(name.endsWith('.pom') ? pom(packaging) : `exact old ${name}`);
          },
        },
      );
      assert.deepEqual(requested, names);
      assert.deepEqual(
        result.carrier.artifacts.map((artifact) => path.basename(artifact.path)),
        names,
      );
      await verifyRegistryCarrierIntegrity(result.carrier, {
        cachedReceipt: result.receipt,
        fetchImpl: () => assert.fail('retained receipt must not fetch'),
      });
    }
    for (const fault of ['wrong-coordinate', 'missing-companion']) {
      const requested = [];
      await assert.rejects(
        materializeRegistryCarrierIntegrity(
          {
            id: 'maven:dev.example:retired',
            product: 'fixture',
            ecosystem: 'maven',
            name: 'dev.example:retired',
            version: '1.0.0',
            artifacts: [],
          },
          {
            directory: path.join(root, fault),
            fetchImpl: async (url) => {
              const name = new URL(url).pathname.split('/').at(-1);
              requested.push(name);
              if (name.endsWith('.pom'))
                return new Response(
                  fault === 'wrong-coordinate'
                    ? pom('jar').replace('<artifactId>retired', '<artifactId>wrong')
                    : pom('jar'),
                );
              return new Response('missing', { status: 404 });
            },
          },
        ),
        fault === 'wrong-coordinate' ? /exact coordinate/ : /HTTP 404/,
      );
      assert.equal(requested[0], 'retired-1.0.0.pom');
      assert.deepEqual(readdirSync(path.join(root, fault)), []);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('materializes exact Cargo/npm archives and all Maven companions once and reuses authenticated receipts', async () => {
  mkdirSync(path.join(ROOT, 'target'), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, 'target', 'registry-materialization-test-'));
  try {
    const requested = [];
    const payloads = new Map([
      ['https://crates.io/api/v1/crates/alpha/1.0.0/download', Buffer.from('crate bytes')],
      ['https://registry.npmjs.org/@example/alpha/-/alpha-1.0.0.tgz', Buffer.from('npm bytes')],
      [
        'https://repo1.maven.org/maven2/dev/example/alpha/1.0.0/alpha-1.0.0.pom',
        Buffer.from('pom bytes'),
      ],
      [
        'https://repo1.maven.org/maven2/dev/example/alpha/1.0.0/alpha-1.0.0.jar',
        Buffer.from('jar bytes'),
      ],
      [
        'https://repo1.maven.org/maven2/dev/example/alpha/1.0.0/alpha-1.0.0-sources.jar',
        Buffer.from('sources bytes'),
      ],
    ]);
    const crateBytes = payloads.get('https://crates.io/api/v1/crates/alpha/1.0.0/download');
    const npmBytes = payloads.get('https://registry.npmjs.org/@example/alpha/-/alpha-1.0.0.tgz');
    const fetchImpl = async (url) => {
      requested.push(url);
      if (url === 'https://crates.io/api/v1/crates/alpha/1.0.0') {
        return Response.json({
          version: {
            crate: 'alpha',
            num: '1.0.0',
            checksum: sha(crateBytes, 'sha256'),
            crate_size: crateBytes.length,
          },
        });
      }
      if (url === 'https://registry.npmjs.org/%40example%2Falpha/1.0.0') {
        return Response.json({
          name: '@example/alpha',
          version: '1.0.0',
          dist: {
            integrity: `sha512-${sha(npmBytes, 'sha512', 'base64')}`,
            tarball: 'https://registry.npmjs.org/@example/alpha/-/alpha-1.0.0.tgz',
          },
        });
      }
      const bytes = payloads.get(url);
      assert.ok(bytes, `unexpected acquisition ${url}`);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.subarray(0, 3));
            controller.enqueue(bytes.subarray(3));
            controller.close();
          },
        }),
      );
    };
    const carriers = [
      {
        id: 'cargo:alpha',
        product: 'alpha',
        ecosystem: 'cargo',
        name: 'alpha',
        version: '1.0.0',
        artifacts: [{ path: 'alpha.crate' }],
      },
      {
        id: 'npm:@example/alpha',
        product: 'alpha',
        ecosystem: 'npm',
        name: '@example/alpha',
        version: '1.0.0',
        artifacts: [{ path: 'alpha.tgz', size: npmBytes.length, sha256: sha(npmBytes, 'sha256') }],
      },
      {
        id: 'maven:dev.example:alpha',
        product: 'alpha',
        ecosystem: 'maven',
        name: 'dev.example:alpha',
        version: '1.0.0',
        artifacts: [
          { path: 'alpha-1.0.0.pom' },
          { path: 'alpha-1.0.0.jar' },
          { path: 'alpha-1.0.0-sources.jar' },
        ],
      },
    ];
    const gateRequests = [];
    const results = [];
    for (const [publishOrder, carrier] of carriers.entries()) {
      const result = await materializeRegistryCarrierIntegrity(
        { ...carrier, publishOrder },
        {
          directory: root,
          fetchImpl,
          cratesIoReadGate: { beforeRequest: async (url) => gateRequests.push(url), defer() {} },
        },
      );
      results.push(result);
      for (const artifact of result.carrier.artifacts) {
        assert.ok(path.isAbsolute(artifact.path));
        assert.equal(sha(readFileSync(artifact.path), 'sha256'), artifact.sha256);
        assert.equal(lstatSync(artifact.path).size, artifact.size);
        assert.equal(lstatSync(artifact.path).mode & 0o222, 0);
      }
      assert.deepEqual(
        await verifyRegistryCarrierIntegrity(result.carrier, {
          cachedReceipt: result.receipt,
          fetchImpl: () => assert.fail('cached receipt must not fetch'),
        }),
        result.receipt,
      );
      assert.deepEqual(
        await verifyRegistryCarrierIntegrity(result.carrier, {
          cachedReceipts: new Map([[result.carrier.id, result.receipt]]),
          fetchImpl: () => assert.fail('mapped cached receipt must not fetch'),
        }),
        result.receipt,
      );
    }
    assert.equal(requested.length, 7);
    assert.equal(new Set(requested).size, requested.length);
    await assert.rejects(
      verifyRegistryCarrierIntegrity(results[0].carrier, {
        cachedReceipt: { ...results[0].receipt, product: 'different' },
        cachedReceipts: new Map([[results[0].carrier.id, results[0].receipt]]),
      }),
      /conflicting cached registry receipts/u,
    );
    assert.deepEqual(gateRequests, [
      'https://crates.io/api/v1/crates/alpha/1.0.0',
      'https://crates.io/api/v1/crates/alpha/1.0.0/download',
    ]);
    assert.deepEqual(
      await verifyLockedRegistryIntegrity(
        { carriers: results.map(({ carrier }) => carrier) },
        {
          cachedReceipts: new Map(results.map(({ receipt }) => [receipt.id, receipt])),
          fetchImpl: () => assert.fail('bulk cached receipt must not fetch'),
        },
      ),
      results.map(({ receipt }) => receipt),
    );
    await assert.rejects(
      verifyRegistryCarrierIntegrity(
        { ...results[0].carrier, version: '2.0.0' },
        { cachedReceipt: results[0].receipt },
      ),
      /changed version/u,
    );
    const npmFile = results[1].carrier.artifacts[0].path;
    chmodSync(npmFile, 0o600);
    writeFileSync(npmFile, Buffer.from('changed!!'));
    await assert.rejects(
      verifyRegistryCarrierIntegrity(results[1].carrier, { cachedReceipt: results[1].receipt }),
      /no longer matches/u,
    );
    const symlink = path.join(root, 'unrelated.tgz');
    symlinkSync(results[1].carrier.artifacts[0].path, symlink);
    await assert.rejects(
      verifyRegistryCarrierIntegrity(
        {
          ...results[1].carrier,
          artifacts: [{ ...results[1].carrier.artifacts[0], path: symlink }],
        },
        { cachedReceipt: results[1].receipt },
      ),
      /regular owned files/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registry materialization rejects metadata, bounds, digest and descriptor conflicts without retaining partial files', async () => {
  mkdirSync(path.join(ROOT, 'target'), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, 'target', 'registry-materialization-negative-'));
  try {
    const bytes = Buffer.from('archive bytes');
    const npmCarrier = {
      id: 'npm:alpha',
      product: 'alpha',
      ecosystem: 'npm',
      name: 'alpha',
      version: '1.0.0',
      artifacts: [{ path: 'alpha.tgz' }],
    };
    const metadata = {
      name: 'alpha',
      version: '1.0.0',
      dist: {
        integrity: `sha512-${sha(bytes, 'sha512', 'base64')}`,
        tarball: 'https://registry.npmjs.org/alpha/-/alpha-1.0.0.tgz',
      },
    };
    const cases = [
      {
        metadata: { ...metadata, version: '2.0.0' },
        match: /exact package version identity/u,
        calls: 1,
      },
      {
        metadata: {
          ...metadata,
          dist: { ...metadata.dist, tarball: 'https://example.com/alpha.tgz' },
        },
        match: /canonical package version URL/u,
        calls: 1,
      },
      { bytes: Buffer.from('wrong bytes'), match: /SHA512/u, calls: 2 },
      { maximumBytes: 3, match: /exceeds locked size/u, calls: 2 },
      {
        artifacts: [{ path: 'alpha.tgz', size: bytes.length + 1 }],
        match: /does not match expected size/u,
        calls: 2,
      },
      { artifacts: [{ path: 'alpha.tgz', sha256: '0'.repeat(64) }], match: /SHA256/u, calls: 2 },
      {
        artifacts: [{ path: 'alpha.tgz', sha256: 'bad' }],
        match: /invalid expected artifact SHA256/u,
        calls: 0,
      },
      {
        artifacts: [{ path: 'alpha.tgz' }, { path: 'other.tgz' }],
        match: /exactly one/u,
        calls: 0,
      },
      { name: '../alpha', match: /invalid exact registry package name/u, calls: 0 },
    ];
    for (const scenario of cases) {
      let calls = 0;
      await assert.rejects(
        materializeRegistryCarrierIntegrity(
          {
            ...npmCarrier,
            name: scenario.name ?? npmCarrier.name,
            artifacts: scenario.artifacts ?? npmCarrier.artifacts,
          },
          {
            directory: root,
            maximumBytes: scenario.maximumBytes ?? 1024,
            fetchImpl: async () => {
              calls += 1;
              return calls === 1
                ? Response.json(scenario.metadata ?? metadata)
                : new Response(scenario.bytes ?? bytes);
            },
          },
        ),
        scenario.match,
      );
      assert.equal(calls, scenario.calls);
      assert.deepEqual(readdirSync(root), []);
    }
    const cargo = {
      ...npmCarrier,
      id: 'cargo:alpha',
      ecosystem: 'cargo',
      artifacts: [{ path: 'alpha.crate', sha256: '0'.repeat(64) }],
    };
    await assert.rejects(
      materializeRegistryCarrierIntegrity(cargo, {
        directory: root,
        cratesIoReadGate: null,
        fetchImpl: async () =>
          Response.json({
            version: { crate: 'alpha', num: '1.0.0', checksum: sha(bytes, 'sha256') },
          }),
      }),
      /registry checksum mismatch/u,
    );
    assert.deepEqual(readdirSync(root), []);
    let mavenCalls = 0;
    await assert.rejects(
      materializeRegistryCarrierIntegrity(
        {
          ...npmCarrier,
          id: 'maven:alpha',
          ecosystem: 'maven',
          name: 'dev.example:alpha',
          artifacts: [
            { path: 'alpha-1.0.0.pom' },
            { path: 'alpha-1.0.0.jar', sha256: '0'.repeat(64) },
          ],
        },
        {
          directory: root,
          fetchImpl: async () => {
            mavenCalls += 1;
            return new Response(bytes);
          },
        },
      ),
      /SHA256/u,
    );
    assert.equal(mavenCalls, 2);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registry materialization retries a transient partial stream with a fresh owned file', async () => {
  mkdirSync(path.join(ROOT, 'target'), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, 'target', 'registry-materialization-retry-'));
  try {
    const bytes = Buffer.from('complete archive');
    let calls = 0;
    let reads = 0;
    let cancels = 0;
    const result = await materializeRegistryCarrierIntegrity(
      {
        id: 'maven:alpha',
        product: 'alpha',
        ecosystem: 'maven',
        name: 'dev.example:alpha',
        version: '1.0.0',
        artifacts: [{ path: 'alpha-1.0.0.jar', size: bytes.length, sha256: sha(bytes, 'sha256') }],
      },
      {
        directory: root,
        fetchImpl: async () => {
          calls += 1;
          if (calls === 2) return new Response(bytes);
          return {
            ok: true,
            headers: new Headers(),
            body: {
              getReader: () => ({
                read: async () => {
                  reads += 1;
                  if (reads === 1) return { done: false, value: bytes.subarray(0, 3) };
                  throw new Error('transient interrupted stream');
                },
                cancel: async () => {
                  cancels += 1;
                },
                releaseLock() {},
              }),
            },
          };
        },
      },
    );
    assert.equal(calls, 2);
    assert.equal(cancels, 1);
    assert.deepEqual(readFileSync(result.carrier.artifacts[0].path), bytes);
    assert.deepEqual(readdirSync(path.dirname(result.carrier.artifacts[0].path)), [
      'alpha-1.0.0.jar',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('proves Cargo checksum and npm SRI against frozen archive bytes and rejects same-version byte conflicts', async () => {
  mkdirSync(path.join(ROOT, 'target'), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, 'target', 'registry-integrity-test-'));
  try {
    const crateBytes = Buffer.from('exact crate bytes\n');
    const npmBytes = Buffer.from('exact npm tarball bytes\n');
    const crateFile = path.join(root, 'alpha-1.0.0.crate');
    const npmFile = path.join(root, 'alpha-1.0.0.tgz');
    writeFileSync(crateFile, crateBytes);
    writeFileSync(npmFile, npmBytes);
    const lock = {
      lockDigest: 'a'.repeat(64),
      source: { commit: 'b'.repeat(40), tree: 'c'.repeat(40) },
      carriers: [
        {
          id: 'cargo:alpha',
          product: 'alpha',
          ecosystem: 'cargo',
          name: 'alpha',
          version: '1.0.0',
          publishOrder: 0,
          artifacts: [
            {
              path: path.relative(ROOT, crateFile),
              sha256: sha(crateBytes, 'sha256'),
              size: statSync(crateFile).size,
            },
          ],
        },
        {
          id: 'npm:@example/alpha',
          product: 'alpha',
          ecosystem: 'npm',
          name: '@example/alpha',
          version: '1.0.0',
          publishOrder: 1,
          artifacts: [
            {
              path: path.relative(ROOT, npmFile),
              sha256: sha(npmBytes, 'sha256'),
              size: statSync(npmFile).size,
            },
          ],
        },
      ],
    };
    const requestedUrls = [];
    const goodFetch = async (url) => {
      requestedUrls.push(url);
      return Response.json(
        url.includes('crates')
          ? { version: { checksum: sha(crateBytes, 'sha256') } }
          : { dist: { integrity: `sha512-${sha(npmBytes, 'sha512', 'base64')}` } },
      );
    };
    const cargo = await verifyLockedCarrierIntegrity(lock, 'cargo:alpha', { fetchImpl: goodFetch });
    const npm = await verifyLockedCarrierIntegrity(lock, 'npm:@example/alpha', {
      fetchImpl: goodFetch,
    });
    assert.equal(cargo.registryProof.digest, sha(crateBytes, 'sha256'));
    assert.equal(npm.registryProof.digest, sha(npmBytes, 'sha512', 'base64'));
    assert.equal(npm.registryProof.url, 'https://registry.npmjs.org/%40example%2Falpha/1.0.0');
    assert.ok(requestedUrls.includes('https://registry.npmjs.org/%40example%2Falpha/1.0.0'));
    const cargoReadStarts = [];
    const bulk = await verifyLockedRegistryIntegrity(lock, {
      products: ['alpha'],
      ecosystems: ['cargo', 'npm'],
      fetchImpl: goodFetch,
      concurrency: 2,
      cratesIoReadGate: {
        beforeRequest: async (label) => cargoReadStarts.push(label),
        defer: () => {},
      },
    });
    assert.deepEqual(
      bulk.map((receipt) => receipt.id),
      ['cargo:alpha', 'npm:@example/alpha'],
    );
    assert.deepEqual(cargoReadStarts, ['https://crates.io/api/v1/crates/alpha/1.0.0']);
    assert.deepEqual(
      validateLockedRegistryReceipts(lock, {
        products: ['alpha'],
        ecosystems: ['cargo', 'npm'],
        receipts: bulk,
      }),
      bulk,
    );
    const evidenceFile = path.join(root, 'registry-receipts.json');
    writeRegistryReceiptEvidence(evidenceFile, lock, {
      products: ['alpha'],
      ecosystems: ['cargo', 'npm'],
      receipts: bulk,
    });
    assert.equal(
      validateRegistryReceiptEvidence(evidenceFile, lock, {
        products: ['alpha'],
        ecosystems: ['cargo', 'npm'],
      }).receipts.length,
      2,
    );
    const conflicting = structuredClone(bulk);
    conflicting[0].registryProof.digest = '0'.repeat(64);
    assert.throws(
      () =>
        validateLockedRegistryReceipts(lock, {
          products: ['alpha'],
          ecosystems: ['cargo', 'npm'],
          receipts: conflicting,
        }),
      /does not exactly prove/u,
    );
    await assert.rejects(
      () =>
        verifyLockedRegistryIntegrity(lock, {
          products: ['alpha'],
          ecosystems: ['cargo'],
          fetchImpl: goodFetch,
          concurrency: 0,
        }),
      /concurrency/u,
    );

    const badFetch = async (url) =>
      Response.json(
        url.includes('crates')
          ? { version: { checksum: '0'.repeat(64) } }
          : { dist: { integrity: `sha512-${Buffer.alloc(64).toString('base64')}` } },
      );
    await assert.rejects(
      () => verifyLockedCarrierIntegrity(lock, 'cargo:alpha', { fetchImpl: badFetch }),
      /checksum mismatch/u,
    );
    await assert.rejects(
      () => verifyLockedCarrierIntegrity(lock, 'npm:@example/alpha', { fetchImpl: badFetch }),
      /integrity mismatch/u,
    );

    let rateLimitedAttempts = 0;
    const rateLimitedThenGood = async () => {
      rateLimitedAttempts += 1;
      if (rateLimitedAttempts === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get: (name) => (name === 'retry-after' ? '0' : null) },
          body: { cancel: async () => {} },
        };
      }
      return Response.json({ version: { checksum: sha(crateBytes, 'sha256') } });
    };
    await verifyLockedCarrierIntegrity(lock, 'cargo:alpha', { fetchImpl: rateLimitedThenGood });
    assert.equal(rateLimitedAttempts, 2);

    let authoritativeRetryAttempts = 0;
    const authoritativeDeferrals = [];
    const authoritativeRetryGate = {
      beforeRequest: async () => {},
      defer: (seconds) => authoritativeDeferrals.push(seconds),
    };
    await verifyLockedCarrierIntegrity(lock, 'cargo:alpha', {
      cratesIoReadGate: authoritativeRetryGate,
      fetchImpl: async () => {
        authoritativeRetryAttempts += 1;
        if (authoritativeRetryAttempts === 1) {
          return {
            ok: false,
            status: 429,
            headers: { get: (name) => (name === 'retry-after' ? '45' : null) },
            body: { cancel: async () => {} },
          };
        }
        return Response.json({ version: { checksum: sha(crateBytes, 'sha256') } });
      },
    });
    assert.equal(authoritativeRetryAttempts, 2);
    assert.deepEqual(authoritativeDeferrals, [45]);

    let excessiveRetryAttempts = 0;
    await assert.rejects(
      () =>
        verifyLockedCarrierIntegrity(lock, 'cargo:alpha', {
          cratesIoReadGate: {
            beforeRequest: async () => {},
            defer: () =>
              assert.fail('an excessive Retry-After must fail before deferring the read gate'),
          },
          fetchImpl: async () => {
            excessiveRetryAttempts += 1;
            return {
              ok: false,
              status: 429,
              headers: { get: (name) => (name === 'retry-after' ? '601' : null) },
              body: { cancel: async () => {} },
            };
          },
        }),
      /bounded 600s retry-delay budget/u,
    );
    assert.equal(excessiveRetryAttempts, 1);

    let logicalNowSeconds = 1_000;
    const sharedGateSleeps = [];
    const sharedGate = createCratesIoReadGate({
      nowImpl: () => logicalNowSeconds,
      sleepImpl: async (milliseconds) => {
        sharedGateSleeps.push(milliseconds);
        logicalNowSeconds += milliseconds / 1000;
      },
    });
    await verifyLockedCarrierIntegrity(lock, 'cargo:alpha', {
      fetchImpl: goodFetch,
      cratesIoReadGate: sharedGate,
    });
    await verifyLockedCarrierIntegrity(lock, 'cargo:alpha', {
      fetchImpl: goodFetch,
      cratesIoReadGate: sharedGate,
    });
    assert.deepEqual(sharedGateSleeps, [250]);

    let notFoundAttempts = 0;
    const notFound = async () => {
      notFoundAttempts += 1;
      return { ok: false, status: 404, headers: { get: () => null } };
    };
    await assert.rejects(
      () => verifyLockedCarrierIntegrity(lock, 'cargo:alpha', { fetchImpl: notFound }),
      /HTTP 404.*after 1 attempt/u,
    );
    assert.equal(notFoundAttempts, 1);

    let oversizedAttempts = 0;
    const oversizedMetadata = async () => {
      oversizedAttempts += 1;
      return new Response('{}', {
        headers: { 'content-length': String(8 * 1024 * 1024 + 1) },
      });
    };
    await assert.rejects(
      () => verifyLockedCarrierIntegrity(lock, 'cargo:alpha', { fetchImpl: oversizedMetadata }),
      /response exceeds 8388608 bytes.*after 1 attempt/u,
    );
    assert.equal(oversizedAttempts, 1);

    const previousDeadline = process.env.REGISTRY_MUTATION_DEADLINE_EPOCH;
    let afterDeadlineRequests = 0;
    try {
      process.env.REGISTRY_MUTATION_DEADLINE_EPOCH = String(Math.floor(Date.now() / 1000) - 1);
      await assert.rejects(
        () =>
          verifyLockedCarrierIntegrity(lock, 'npm:@example/alpha', {
            fetchImpl: async () => {
              afterDeadlineRequests += 1;
              return goodFetch('npm');
            },
          }),
        /shared registry mutation deadline has been reached/u,
      );
      assert.equal(afterDeadlineRequests, 0);
    } finally {
      if (previousDeadline === undefined) delete process.env.REGISTRY_MUTATION_DEADLINE_EPOCH;
      else process.env.REGISTRY_MUTATION_DEADLINE_EPOCH = previousDeadline;
    }

    rmSync(crateFile);
    rmSync(npmFile);
    assert.equal(
      validateRegistryReceiptEvidence(evidenceFile, lock, {
        products: ['alpha'],
        ecosystems: ['cargo', 'npm'],
        receiptMode: 'sealed',
      }).receipts.length,
      2,
    );
    assert.throws(
      () =>
        validateRegistryReceiptEvidence(evidenceFile, lock, {
          products: ['alpha'],
          ecosystems: ['cargo', 'npm'],
        }),
      /locked artifact is unavailable/u,
    );

    const changedCargo = structuredClone(bulk);
    changedCargo[0].registryProof.digest = '0'.repeat(64);
    assert.throws(
      () =>
        validateLockedRegistryReceipts(lock, {
          products: ['alpha'],
          ecosystems: ['cargo', 'npm'],
          receiptMode: 'sealed',
          receipts: changedCargo,
        }),
      /sealed Cargo proof changed/u,
    );
    const changedNpm = structuredClone(bulk);
    changedNpm[1].registryProof.digest = 'not-base64';
    assert.throws(
      () =>
        validateLockedRegistryReceipts(lock, {
          products: ['alpha'],
          ecosystems: ['cargo', 'npm'],
          receiptMode: 'sealed',
          receipts: changedNpm,
        }),
      /canonical SHA-512 base64/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('proves every frozen Maven payload before an immutable-version skip', async () => {
  mkdirSync(path.join(ROOT, 'target'), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, 'target', 'registry-integrity-maven-test-'));
  try {
    const mavenBytes = Buffer.from('exact Maven payload bytes\n');
    const mavenFile = path.join(root, 'native-runtime.tar.gz');
    writeFileSync(mavenFile, mavenBytes);

    const lock = {
      carriers: [
        {
          id: 'maven:dev.example:alpha-native',
          product: 'alpha',
          ecosystem: 'maven',
          name: 'dev.example:alpha-native',
          version: '1.0.0',
          publishOrder: 0,
          artifacts: [
            {
              path: path.relative(ROOT, mavenFile),
              sha256: sha(mavenBytes, 'sha256'),
              size: mavenBytes.length,
            },
          ],
        },
      ],
    };
    const goodFetch = async () => new Response(mavenBytes);

    const maven = await verifyLockedCarrierIntegrity(lock, 'maven:dev.example:alpha-native', {
      fetchImpl: goodFetch,
    });
    assert.equal(maven.registryProof.files[0].digest, sha(mavenBytes, 'sha256'));

    const wrongMavenFetch = async () => new Response(Buffer.from('different immutable bytes\n'));
    await assert.rejects(
      () =>
        verifyLockedCarrierIntegrity(lock, 'maven:dev.example:alpha-native', {
          fetchImpl: wrongMavenFetch,
        }),
      /Maven payload mismatch/u,
    );
    let oversizedPayloadAttempts = 0;
    const oversizedMavenFetch = async () => {
      oversizedPayloadAttempts += 1;
      return new Response(mavenBytes, {
        headers: { 'content-length': String(mavenBytes.length + 1) },
      });
    };
    await assert.rejects(
      () =>
        verifyLockedCarrierIntegrity(lock, 'maven:dev.example:alpha-native', {
          fetchImpl: oversizedMavenFetch,
        }),
      /response exceeds locked size.*after 1 attempt/u,
    );
    assert.equal(oversizedPayloadAttempts, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writes and revalidates exhaustive empty evidence for a selected source-only release', () => {
  mkdirSync(path.join(ROOT, 'target'), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, 'target', 'registry-integrity-empty-test-'));
  try {
    const lock = {
      lockDigest: 'd'.repeat(64),
      source: { commit: 'e'.repeat(40), tree: 'f'.repeat(40) },
      carriers: [],
    };
    const file = path.join(root, 'empty-receipts.json');
    const ecosystems = ['cargo', 'npm', 'maven'];
    const written = writeRegistryReceiptEvidence(file, lock, {
      products: ['oliphaunt-swift'],
      ecosystems,
      receipts: [],
    });
    assert.deepEqual(written.receipts, []);
    const verified = validateRegistryReceiptEvidence(file, lock, {
      products: ['oliphaunt-swift'],
      ecosystems,
    });
    assert.deepEqual(verified.products, ['oliphaunt-swift']);
    assert.deepEqual(verified.receipts, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

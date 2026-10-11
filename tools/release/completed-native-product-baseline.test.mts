import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  captureCompletedNativeProductBaselines,
  recordCompletedNativeProductBaselines,
} from './completed-native-product-baseline.mts';
import { fixture, source } from './completed-native-publication.fixture.mts';

test('completed projection binds genuine packed bytes, cache-backed configured tests and held contracts per product', async () => {
  await fixture(async ({ input, transports, requests }) => {
    const record = await captureCompletedNativeProductBaselines(input, transports);
    expect(requests).toEqual(['alpha', 'beta', 'auth']);
    expect(record.coverage.completeFrozenInventory).toBe(true);
    expect(record.coverage.completeMigrationInventory).toBe('unverified');
    expect(record.products.map((product) => product.preEnvelopeCapture)).toEqual([
      'absent',
      'observed',
    ]);
    expect(record.products.every((product) => product.baselineAdmission === 'unknown')).toBe(true);
    expect(record.releaseDecision).toBe('unverified');
    expect(record.products[0].carriers[0].packageDependencies[0].requirement).toBe('=0.3.2');
    expect(
      record.products[0].construction[0].inputs.some((input) => input.path.includes('/beta/')),
    ).toBe(false);
    expect(
      record.products[1].construction[0].roots.find((root) => root.package.ecosystem === 'internal')
        .outputs[0].members[1].sha256,
    ).toMatch(/^[a-f0-9]{64}$/u);
    expect(record.builds[0].requiredTests).toHaveLength(2);
    expect(record.builds[0].testQualification).toBe('passed');
    expect(record.publication.registryReceipts).toHaveLength(2);
    expect(record.unverified).toContain(
      'immutable input lifetime from the producing build through content capture',
    );
  });
});

test('pending or mismatched canonical completion cannot write an observation file', async () => {
  await fixture(async ({ input, transports, directory }) => {
    const output = path.join(directory, 'completed.json');
    for (const assertCompleted of [
      async () => {
        throw new Error('publication is not complete');
      },
      async (requested) => ({
        ...requested,
        publicationTree: '9'.repeat(40),
        releaseSha: 'f'.repeat(40),
      }),
    ]) {
      await expect(
        recordCompletedNativeProductBaselines(output, input, { ...transports, assertCompleted }),
      ).rejects.toThrow();
      expect(existsSync(output)).toBe(false);
    }
  });
});

test('stale source/run, failed mandatory test and incomplete configured inventory fail closed', async () => {
  await fixture(async ({ input, transports, origin }) => {
    const missingPlan = structuredClone(input);
    delete missingPlan.builds[0].requiredTests;
    await expect(captureCompletedNativeProductBaselines(missingPlan, transports)).rejects.toThrow(
      /nonempty configured test plan/,
    );
    const wrongSource = structuredClone(input);
    wrongSource.builds[0].expected.source = { ...source, commit: '9'.repeat(40) };
    await expect(captureCompletedNativeProductBaselines(wrongSource, transports)).rejects.toThrow(
      /source/,
    );
    for (const change of [
      (evidence) => {
        evidence.github.runAttempt = 2;
      },
      (evidence) => {
        evidence.cohorts[0].buildEvents.find((event) => event.testResult).testResult.status =
          'FAILED';
      },
      (evidence) => {
        evidence.cohorts[0].roots = evidence.cohorts[0].roots.filter(
          (root) => root.package.product !== 'alpha',
        );
        evidence.cohorts[0].rootConfigurations = evidence.cohorts[0].rootConfigurations.filter(
          (root) => !root.label.includes('/alpha:'),
        );
        evidence.cohorts[0].outputs = evidence.cohorts[0].outputs.filter(
          (output) => !output.path.includes('/alpha/'),
        );
        evidence.cohorts[0].inputs = evidence.cohorts[0].inputs.filter(
          (input) => !input.path.includes('/alpha/'),
        );
      },
    ]) {
      const modified = structuredClone(origin);
      change(modified.evidence);
      await expect(
        captureCompletedNativeProductBaselines(input, {
          ...transports,
          authenticate: async () => modified,
        }),
      ).rejects.toThrow();
    }
  });
});

test('frozen final artifact substitution and remote registry/asset substitution are rejected', async () => {
  await fixture(async ({ input, transports, releases, rehash }) => {
    const substituted = structuredClone(input);
    substituted.publicationLock.carriers[0].artifacts[0] = {
      ...substituted.publicationLock.carriers[0].artifacts[0],
      sha256: '9'.repeat(64),
    };
    rehash(substituted.publicationLock);
    await expect(captureCompletedNativeProductBaselines(substituted, transports)).rejects.toThrow(
      /frozen file envelope/,
    );
    await expect(
      captureCompletedNativeProductBaselines(input, {
        ...transports,
        verifyRegistry: async () => [],
      }),
    ).rejects.toThrow(/incomplete/);
    const wrongAsset = structuredClone(releases);
    wrongAsset[1].assets[0].sha256 = '9'.repeat(64);
    await expect(
      captureCompletedNativeProductBaselines(input, {
        ...transports,
        readGithubReleases: async () => wrongAsset,
      }),
    ).rejects.toThrow(/differs/);
    const draft = structuredClone(releases);
    draft[0].draft = true;
    await expect(
      captureCompletedNativeProductBaselines(input, {
        ...transports,
        readGithubReleases: async () => draft,
      }),
    ).rejects.toThrow(/stable public/);
  });
});

test('immutable completion persistence is idempotent and preserves existing files and safe ancestors', async () => {
  await fixture(async ({ input, transports, directory }) => {
    const output = path.join(directory, 'completed/observations.json');
    const record = await recordCompletedNativeProductBaselines(output, input, transports);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(record);
    await recordCompletedNativeProductBaselines(output, input, transports);
    const before = readFileSync(output);
    const differing = structuredClone(input);
    differing.builds[0].requiredTests = differing.builds[0].requiredTests.slice(0, 1);
    await expect(
      recordCompletedNativeProductBaselines(output, differing, transports),
    ).rejects.toThrow(/non-identical/);
    expect(readFileSync(output)).toEqual(before);
    symlinkSync(path.join(directory, 'completed'), path.join(directory, 'alias'), 'dir');
    await expect(
      recordCompletedNativeProductBaselines(
        path.join(directory, 'alias/other.json'),
        input,
        transports,
      ),
    ).rejects.toThrow(/symlink/);
  });
});

test('CLI rejects historical ref validation in a newer checkout before reading the current catalog', async () => {
  await fixture(async ({ directory }) => {
    const workspace = path.join(directory, 'history');
    mkdirSync(path.join(workspace, 'tools/release'), { recursive: true });
    const wrapper = path.join(workspace, 'tools/release/with-source.sh');
    copyFileSync(path.resolve(import.meta.dir, 'with-source.sh'), wrapper);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('add', 'tools/release/with-source.sh');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'old publication source',
    );
    const publication = git('rev-parse', 'HEAD');
    writeFileSync(path.join(workspace, 'new-source.txt'), 'unrelated newer source');
    git('add', 'new-source.txt');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'new source',
    );
    let failure;
    try {
      execFileSync(
        'bash',
        [
          wrapper,
          publication,
          process.execPath,
          path.resolve(import.meta.dir, 'completed-native-product-baseline.mts'),
          '--head-ref',
          publication,
          '--lock',
          path.join(workspace, 'does-not-exist.json'),
        ],
        { encoding: 'utf8', stdio: 'pipe', timeout: 90_000 },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure?.status).toBe(1);
    expect(String(failure?.stderr)).toContain('exact publication checkout');
    expect(String(failure?.stderr)).not.toContain('cannot read publication lock');
  });
}, 120_000);

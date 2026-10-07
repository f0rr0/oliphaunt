import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { expectedOidcIdentity } from '../../.github/scripts/verify-github-oidc-identity.mts';
import { frozenNpmIntegrity } from './frozen-npm-publish.mts';
import { verifyNpmTrustedPublishers } from './npm-trusted-publisher-readiness.mts';

const environment = {
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'github-request-secret',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.example/token?api-version=1',
  CANONICAL_RELEASE_REPOSITORY: 'f0rr0/oliphaunt',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: '1'.repeat(40),
  RELEASE_OPERATION: 'publish',
};
const now = Date.parse('2026-10-07T12:00:00Z');
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
const jwt = (claims) =>
  ['header', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'signature'].join('.');

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-npm-trust-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return ['first', 'second', 'third'].map((name) => {
    const tarball = path.join(directory, name + '.tgz');
    writeFileSync(tarball, 'frozen-' + name);
    return { name: '@oliphaunt/' + name, version: '0.3.1', tarball };
  });
}

function transport(
  carriers,
  { denied = undefined, published = [], claims = {}, exchanged = {} } = {},
) {
  const calls = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });
    assert.equal(options.redirect, 'error');
    assert(options.signal instanceof AbortSignal);
    if (url.hostname === 'actions.example') {
      assert.equal(url.searchParams.get('audience'), 'npm:registry.npmjs.org');
      assert.equal(options.headers.Authorization, 'Bearer github-request-secret');
      return response({
        value: jwt({
          ...expectedOidcIdentity(environment),
          aud: 'npm:registry.npmjs.org',
          ...claims,
        }),
      });
    }
    assert.equal(url.origin, 'https://registry.npmjs.org');
    if (url.pathname.startsWith('/-/npm/v1/oidc/token/exchange/package/')) {
      assert.equal(options.method, 'POST');
      assert(options.headers.Authorization.startsWith('Bearer header.'));
      const name = decodeURIComponent(url.pathname.split('/').at(-1));
      if (name === denied) return response({ error: 'expired publisher; registry-secret' }, 401);
      return response(
        {
          token_type: 'oidc',
          token: 'npm-issued-secret',
          expires: '2026-10-07T13:00:00Z',
          ...exchanged,
        },
        201,
      );
    }
    assert.equal(options.method, undefined);
    const [name, version] = url.pathname.slice(1).split('/').map(decodeURIComponent);
    const carrier = carriers.find((row) => row.name === name);
    assert(carrier);
    if (version === undefined) return response({ name });
    assert.equal(version, carrier.version);
    return published.includes(name)
      ? response({ dist: { integrity: frozenNpmIntegrity(carrier.tarball) } })
      : response({ error: 'version absent' }, 404);
  };
  return { calls, fetchImpl };
}

test('exchanges every pending frozen package and skips byte-matching public versions', async (t) => {
  const carriers = fixture(t);
  const mock = transport(carriers, { published: [carriers[1].name] });
  const result = await verifyNpmTrustedPublishers({
    carriers,
    environment,
    fetchImpl: mock.fetchImpl,
    nowImpl: () => now,
  });
  assert.deepEqual(result, {
    published: [carriers[1].name],
    authorized: [carriers[0].name, carriers[2].name],
  });
  assert.equal(mock.calls.filter(({ options }) => options.method === 'POST').length, 2);
  assert(!JSON.stringify(result).includes('secret'));
});

test('an expired publisher stops the complete preflight before later packages, without exposing tokens', async (t) => {
  const carriers = fixture(t);
  const mock = transport(carriers, { denied: carriers[1].name });
  await assert.rejects(
    verifyNpmTrustedPublishers({
      carriers,
      environment,
      fetchImpl: mock.fetchImpl,
      nowImpl: () => now,
    }),
    (error) => {
      assert(error.message.includes(carriers[1].name));
      assert(error.message.includes('HTTP 401'));
      assert(error.message.includes('unused rules expire after two days'));
      assert(!error.message.includes('secret'));
      return true;
    },
  );
  assert(
    !mock.calls.some(({ url }) => decodeURIComponent(url.pathname).includes(carriers[2].name)),
  );
});

test('rejects a different workflow identity before exchanging an npm credential', async (t) => {
  const carriers = fixture(t);
  const mock = transport(carriers, { claims: { environment: 'release-bootstrap' } });
  await assert.rejects(
    verifyNpmTrustedPublishers({
      carriers,
      environment,
      fetchImpl: mock.fetchImpl,
      nowImpl: () => now,
    }),
    /claim environment mismatch/u,
  );
  assert(!mock.calls.some(({ options }) => options.method === 'POST'));
});

test('rejects unusable credentials and stops at the shared deadline', async (t) => {
  const carriers = fixture(t);
  for (const exchanged of [
    { token: '' },
    { token_type: 'session' },
    { expires: '2026-10-07T11:59:59Z' },
  ]) {
    const mock = transport(carriers, { exchanged });
    await assert.rejects(
      verifyNpmTrustedPublishers({
        carriers,
        environment,
        fetchImpl: mock.fetchImpl,
        nowImpl: () => now,
      }),
      /did not receive a usable credential/u,
    );
  }
  await assert.rejects(
    verifyNpmTrustedPublishers({
      carriers,
      environment,
      fetchImpl: async () => assert.fail('network after deadline'),
      nowImpl: () => now,
      deadlineEpochSeconds: Math.floor(now / 1000),
    }),
    /deadline/u,
  );
});

test('the publish workflow checks the complete frozen npm scope before any release mutation', () => {
  const workflow = Bun.YAML.parse(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  );
  const steps = workflow.jobs.publish.steps;
  const preflight = steps.findIndex(({ id }) => id === 'verify_npm_trusted_authorization');
  assert(preflight >= 0);
  assert(steps[preflight].run.includes('--publication-lock "$PUBLICATION_LOCK_PATH"'));
  assert.equal(steps[preflight].env.RELEASE_OPERATION, 'publish');
  assert.equal(workflow.jobs.publish.environment, 'release-publish');
  for (const id of [
    'ensure_release_transport_ref',
    'stage_github_releases',
    'publish_github_assets',
    'publish_registries',
  ]) {
    const mutation = steps.findIndex((step) => step.id === id);
    assert(mutation > preflight, `${id} must follow npm authorization preflight`);
  }
});

import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createReleaseAppToken } from './release-app-token.mts';
import { requestGithubMutation } from './github-release-mutations.mts';
import { requestGithubPages, requestGithubRepositoryJson } from './github-read.mts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const environment = {
  GITHUB_REPOSITORY: 'f0rr0/oliphaunt',
  RELEASE_TAG_APP_CLIENT_ID: 'Iv1.fixture',
  RELEASE_TAG_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  RELEASE_APP_INSTALLATION_ID: '123',
};

test('concurrent upload lanes share refreshes, rotate before expiry, and revoke after draining', async () => {
  let clock = Date.parse('2026-10-05T00:00:00Z');
  const masked = [];
  const revoked = [];
  let created = 0;
  const credentials = createReleaseAppToken({
    environment,
    now: () => clock,
    mask: (token) => masked.push(token),
    fetchImpl: async (url, init) => {
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      if (init.method === 'DELETE') {
        assert.equal(url, 'https://api.github.com/installation/token');
        revoked.push(init.headers.Authorization);
        return new Response(null, { status: 204 });
      }
      assert.equal(url, 'https://api.github.com/app/installations/123/access_tokens');
      assert.deepEqual(JSON.parse(init.body), {
        repositories: ['oliphaunt'],
        permissions: { contents: 'write' },
      });
      const jwt = init.headers.Authorization.slice('Bearer '.length);
      const [header, payload, signature] = jwt.split('.');
      assert.equal(
        verify(
          'RSA-SHA256',
          Buffer.from(`${header}.${payload}`),
          publicKey,
          Buffer.from(signature, 'base64url'),
        ),
        true,
      );
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
      assert.equal(claims.iss, environment.RELEASE_TAG_APP_CLIENT_ID);
      assert.equal(claims.iat, Math.floor(clock / 1000) - 60);
      assert.equal(claims.exp, Math.floor(clock / 1000) + 540);
      created += 1;
      await Promise.resolve();
      return Response.json({
        token: `fixture-${created}`,
        expires_at: new Date(clock + 60 * 60_000).toISOString(),
        permissions: { contents: 'write', metadata: 'read' },
      });
    },
  });
  assert.deepEqual(
    await Promise.all(Array.from({ length: 5 }, () => credentials.token())),
    Array(5).fill('fixture-1'),
  );
  clock += 54 * 60_000;
  assert.equal(await credentials.token(), 'fixture-1');
  clock += 60_000;
  assert.deepEqual(
    await Promise.all(Array.from({ length: 5 }, () => credentials.token())),
    Array(5).fill('fixture-2'),
  );
  assert.equal(created, 2);
  assert.deepEqual(masked, ['fixture-1', 'fixture-2']);
  assert.deepEqual(revoked, []);
  await credentials.close();
  assert.deepEqual(revoked, ['Bearer fixture-1', 'Bearer fixture-2']);
  await assert.rejects(credentials.token(), /closed/u);
});

test('invalid or unavailable App credentials fail without falling back to the Actions token', async () => {
  assert.throws(
    () =>
      createReleaseAppToken({ environment: { ...environment, GITHUB_REPOSITORY: 'other/repo' } }),
    /canonical/u,
  );
  assert.throws(
    () =>
      createReleaseAppToken({ environment: { ...environment, RELEASE_TAG_APP_PRIVATE_KEY: '' } }),
    /private key/u,
  );
  let writes = 0;
  const credentials = createReleaseAppToken({
    environment: { ...environment, GH_TOKEN: 'native-token' },
    mask: () => {},
    fetchImpl: () => new Response('private response', { status: 403 }),
  });
  await assert.rejects(
    requestGithubMutation('repos/o/r/git/refs', {
      environment: { GH_TOKEN: 'native-token' },
      getToken: () => credentials.token(),
      method: 'POST',
      input: JSON.stringify({ ref: 'refs/tags/v1', sha: 'a'.repeat(40) }),
      timeoutMs: 1000,
      fetchImpl: () => {
        writes += 1;
        return Response.json({});
      },
    }),
    /HTTP 403/u,
  );
  assert.equal(writes, 0);
  await credentials.close();
});

test('unexpected token permissions fail closed and still revoke the returned credential', async () => {
  const calls = [];
  const credentials = createReleaseAppToken({
    environment,
    mask: () => {},
    fetchImpl: (url, init) => {
      calls.push(init.method);
      return init.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : Response.json({
            token: 'fixture-token',
            expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
            permissions: { contents: 'write', workflows: 'write' },
          });
    },
  });
  await assert.rejects(credentials.token(), /invalid expiry or permissions/u);
  await credentials.close();
  assert.deepEqual(calls, ['POST', 'DELETE']);
});

test('mutation transports use the renewable App credential and redact it from errors', async () => {
  let calls = 0;
  await assert.rejects(
    requestGithubMutation('repos/o/r/git/refs', {
      environment: { GH_TOKEN: 'native-token' },
      getToken: async () => 'oli-private-token',
      method: 'POST',
      input: JSON.stringify({ ref: 'refs/tags/v1', sha: 'a'.repeat(40) }),
      timeoutMs: 1000,
      fetchImpl: (url, init) => {
        calls += 1;
        assert.equal(init.headers.Authorization, 'Bearer oli-private-token');
        return new Response('oli-private-token', { status: 503 });
      },
    }),
    (cause) => !cause.detail.includes('oli-private-token') && cause.detail.includes('<redacted>'),
  );
  assert.equal(calls, 1, 'a token change must never replay a release mutation');
});

test('release workflow reserves repository mutations for Oli with per-step token scopes', () => {
  const workflow = Bun.YAML.parse(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  );
  for (const name of ['prepare-release-pr', 'publish-bootstrap', 'publish']) {
    for (const scope of [
      'contents',
      'issues',
      'pull-requests',
      'attestations',
      'artifact-metadata',
    ])
      assert.notEqual(workflow.jobs[name].permissions[scope], 'write', `${name} ${scope}`);
  }
  const steps = new Map(workflow.jobs.publish.steps.map((step) => [step.id ?? step.name, step]));
  assert.equal(
    steps.get('promote_github_releases').env.GH_TOKEN,
    '${{ steps.release_promotion_token.outputs.token }}',
  );
  assert.equal(
    steps.get('release_provenance').with['github-token'],
    '${{ steps.release_attestation_token.outputs.token }}',
  );
  assert.equal(
    steps.get('publish_github_assets').env.RELEASE_APP_INSTALLATION_ID,
    '${{ steps.check_release_tag_app.outputs.installation-id }}',
  );
  assert.equal(steps.get('release_attestation_token').with['permission-attestations'], 'write');
  const pr = workflow.jobs['prepare-release-pr'];
  assert.equal(pr.environment, 'release-pr');
  for (const step of pr.steps.filter((step) => step.env?.GH_TOKEN))
    assert.equal(step.env.GH_TOKEN, '${{ steps.release_pr_token.outputs.token }}');
  for (const name of ['publish-bootstrap', 'publish']) {
    const preflight = workflow.jobs[name].steps.find(
      (step) => step.name === 'Preflight selected product tag and release collisions',
    );
    assert.match(preflight.env.GH_TOKEN, /steps\.[a-z_]+\.outputs\.token/u);
    const tokenId = preflight.env.GH_TOKEN.match(/steps\.([a-z_]+)\.outputs/u)[1];
    const tokenStep = workflow.jobs[name].steps.find((step) => step.id === tokenId);
    assert.equal(tokenStep.with['permission-contents'], 'write', 'draft collision visibility');
  }
  assert.equal(workflow.jobs['request-qualification'].permissions.actions, 'write');
  assert.equal(workflow.jobs['publish-bootstrap'].permissions['id-token'], 'write');
  assert.equal(workflow.jobs.publish.permissions['id-token'], 'write');
});

test('draft inventories resolve fresh App credentials for repository and paginated reads', async () => {
  let generation = 0;
  const options = {
    environment: { GH_TOKEN: 'native-token' },
    getToken: async () => `oli-${++generation}`,
    fetchImpl: (url, init) => {
      assert.equal(init.headers.Authorization, `Bearer oli-${generation}`);
      return Response.json([]);
    },
  };
  await requestGithubRepositoryJson('repos/o/r/releases/42', options);
  await requestGithubPages('repos/o/r/releases', options);
  assert.equal(generation, 2);
});

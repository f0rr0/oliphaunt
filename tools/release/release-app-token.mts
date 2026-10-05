import { createPrivateKey, sign } from 'node:crypto';
import { reserveGitHubCoreRequest } from './github-core-request-journal.mts';
import { authHeaders, boundedResponseBytes } from './github-read.mts';

const REFRESH_MARGIN_MS = 5 * 60_000;

// Uploads can span several one-hour installation tokens. Keep a single shared
// refresh in flight, and revoke issued tokens only after all upload lanes drain.
export function createReleaseAppToken({
  environment = process.env,
  fetchImpl = fetch,
  now = Date.now,
  mask = (token) => {
    if (environment.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${token}`);
  },
} = {}) {
  if (environment.GITHUB_REPOSITORY !== 'f0rr0/oliphaunt')
    throw new Error('Oli upload credentials require the canonical release repository');
  const clientId = environment.RELEASE_TAG_APP_CLIENT_ID;
  const installationId = environment.RELEASE_APP_INSTALLATION_ID;
  if (!/^[A-Za-z0-9_.-]+$/u.test(clientId ?? '') || !/^[1-9][0-9]*$/u.test(installationId ?? ''))
    throw new Error('Oli upload credentials require the App client ID and installation ID');
  let key;
  try {
    key = createPrivateKey((environment.RELEASE_TAG_APP_PRIVATE_KEY ?? '').replace(/\\n/gu, '\n'));
    if (key.asymmetricKeyType !== 'rsa') throw new Error('not RSA');
  } catch {
    throw new Error('Oli upload credentials require an RSA App private key');
  }
  const issued = new Map();
  let cached;
  let pending;
  let closed = false;

  async function request(endpoint, credential, method, input) {
    await reserveGitHubCoreRequest({ environment, label: `Oli App token ${method}` });
    let response;
    try {
      response = await fetchImpl(`https://api.github.com/${endpoint}`, {
        method,
        headers: {
          ...authHeaders('application/vnd.github+json', credential),
          'Content-Type': 'application/json',
        },
        body: input === undefined ? undefined : JSON.stringify(input),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error(`Oli App token ${method} transport failed`);
    }
    if (!response.ok) {
      await response.body?.cancel?.();
      throw new Error(`Oli App token ${method} returned HTTP ${response.status}`);
    }
    return response;
  }

  async function refresh() {
    const seconds = Math.floor(now() / 1_000);
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const payload = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iat: seconds - 60,
      exp: seconds + 540,
      iss: clientId,
    })}`;
    const jwt = `${payload}.${sign('RSA-SHA256', Buffer.from(payload), key).toString('base64url')}`;
    const response = await request(
      `app/installations/${installationId}/access_tokens`,
      jwt,
      'POST',
      { repositories: ['oliphaunt'], permissions: { contents: 'write' } },
    );
    let data;
    try {
      const bytes = await boundedResponseBytes(response, 32 * 1024, 'Oli App token response');
      data = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error('Oli App token response is malformed');
    }
    if (typeof data?.token !== 'string' || !/^[A-Za-z0-9_.=-]{1,8192}$/u.test(data.token))
      throw new Error('Oli App token response has no valid installation token');
    mask(data.token);
    const expiresAt = Date.parse(data.expires_at);
    issued.set(data.token, expiresAt);
    if (
      !Number.isFinite(expiresAt) ||
      expiresAt <= now() + REFRESH_MARGIN_MS ||
      data.permissions?.contents !== 'write' ||
      Object.entries(data.permissions).some(
        ([permission, access]) =>
          permission !== 'contents' && !(permission === 'metadata' && access === 'read'),
      )
    )
      throw new Error('Oli App upload token has invalid expiry or permissions');
    cached = { token: data.token, expiresAt };
    return cached.token;
  }

  return {
    async token() {
      if (closed) throw new Error('Oli App upload credentials are closed');
      if (cached?.expiresAt > now() + REFRESH_MARGIN_MS) return cached.token;
      pending ??= refresh().finally(() => {
        pending = undefined;
      });
      return await pending;
    },
    async close() {
      closed = true;
      await pending?.catch(() => {});
      const failures = [];
      for (const [token, expiresAt] of issued) {
        if (expiresAt <= now()) continue;
        try {
          const response = await request('installation/token', token, 'DELETE');
          await response.body?.cancel?.();
        } catch (cause) {
          failures.push(cause.message);
        }
      }
      issued.clear();
      cached = undefined;
      if (failures.length) throw new Error(`Oli App token cleanup failed: ${failures.join('; ')}`);
    },
  };
}

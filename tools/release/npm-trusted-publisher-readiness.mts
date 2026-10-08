import {
  decodeJwtPayload,
  expectedOidcIdentity,
  oidcRequestUrl,
  readBoundedOidcResponse,
  verifyOidcClaims,
} from '../../.github/scripts/verify-github-oidc-identity.mts';
import { prepareFrozenNpmPublication } from './frozen-npm-publish.mts';
import {
  assertPublicationLockSource,
  loadPublicationLock,
  lockedCarrierFile,
  lockedCarriers,
} from './publication-lock.mts';

const AUDIENCE = 'npm:registry.npmjs.org';
const REGISTRY = 'https://registry.npmjs.org';

// Obtain and discard credentials without publishing or activating a new rule.
// npm's CLI hides exchange errors behind ENEEDAUTH during the actual publish.
export async function verifyNpmTrustedPublishers({
  carriers,
  environment = process.env,
  fetchImpl = fetch,
  nowImpl = Date.now,
  deadlineEpochSeconds = Math.floor(nowImpl() / 1000) + 360,
}) {
  const result = { published: [], authorized: [] };
  const request = async (url, options, context) => {
    const remaining = deadlineEpochSeconds * 1000 - nowImpl();
    if (remaining <= 0) throw new Error(`npm trust preflight deadline reached: ${context}`);
    let response;
    try {
      response = await fetchImpl(url, {
        ...options,
        redirect: 'error',
        signal: AbortSignal.timeout(Math.min(15_000, remaining)),
      });
    } catch {
      throw new Error(`npm trust preflight request failed: ${context}`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `${context}: HTTP ${response.status}; audit the package's trusted publisher; ` +
          'unused rules expire after two days and must be recreated before their first OIDC publish',
      );
    }
    // Never include response text or credentials in diagnostics or evidence.
    try {
      return JSON.parse(await readBoundedOidcResponse(response));
    } catch {
      throw new Error(`npm trust preflight returned invalid or oversized JSON: ${context}`);
    }
  };
  for (const carrier of carriers) {
    const prepared = await prepareFrozenNpmPublication({
      ...carrier,
      packageName: carrier.name,
      registry: REGISTRY,
      deadlineEpochSeconds,
      fetchImpl,
      nowImpl,
    });
    if (prepared.skipped) {
      result.published.push(carrier.name);
      continue;
    }
    if (!prepared.state.nameExists)
      throw new Error(`npm trust preflight requires identity bootstrap: ${carrier.name}`);
    const expected = { ...expectedOidcIdentity(environment), aud: AUDIENCE };
    const url = oidcRequestUrl(environment.ACTIONS_ID_TOKEN_REQUEST_URL);
    url.searchParams.set('audience', AUDIENCE);
    const github = await request(
      url,
      { headers: { Authorization: `Bearer ${environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } },
      'GitHub npm OIDC identity',
    );
    verifyOidcClaims(decodeJwtPayload(github.value), expected);
    const exchanged = await request(
      `${REGISTRY}/-/npm/v1/oidc/token/exchange/package/${encodeURIComponent(carrier.name)}`,
      { method: 'POST', headers: { Authorization: `Bearer ${github.value}` } },
      `npm trusted publisher for ${carrier.name}@${carrier.version}`,
    );
    // Match the pinned npm CLI's exchange contract: it consumes response.token.
    // This probe discards the credential; publishing obtains a fresh one, so
    // descriptive token_type/expiry metadata cannot prove that later publish.
    if (typeof exchanged?.token !== 'string' || exchanged.token.length === 0)
      throw new Error(
        `npm trust preflight exchange returned no nonempty token for ${carrier.name}`,
      );
    result.authorized.push(carrier.name);
  }
  return result;
}

if (import.meta.main) {
  const [flag, file] = process.argv.slice(2);
  if (flag !== '--publication-lock' || !file || process.argv.length !== 4)
    throw new Error('usage: npm-trusted-publisher-readiness.mts --publication-lock FILE');
  const lock = loadPublicationLock(file);
  assertPublicationLockSource(lock, process.env.RELEASE_HEAD_SHA ?? 'HEAD');
  const carriers = lockedCarriers(lock, { ecosystem: 'npm' }).map((carrier) => ({
    name: carrier.name,
    version: carrier.version,
    tarball: lockedCarrierFile(lock, 'npm', carrier.name).file,
  }));
  const result = await verifyNpmTrustedPublishers({ carriers });
  console.log(
    `npm trust preflight passed: ${result.authorized.length} pending packages authorized; ` +
      `${result.published.length} immutable matching versions need no publication`,
  );
}

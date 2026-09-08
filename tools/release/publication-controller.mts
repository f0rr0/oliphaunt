import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Only publication execution may differ. In particular, tools/release also
// contains packagers: allowing that directory wholesale would change bytes.
const CONTROL_FILES = new Set([
  '.github/workflows/release.yml',
  '.github/scripts/resolve-release-head.sh',
  '.github/scripts/validate-release-workflow-inputs.sh',
  '.github/scripts/release-transport-ref.mts',
  '.github/scripts/download-bootstrap-ledger.mts',
  '.github/scripts/download-bootstrap-ledger.test.mts',
  '.github/scripts/download-completed-bootstrap.mts',
  '.github/scripts/download-completed-bootstrap.sh',
  '.github/scripts/normalize-release-please-pr.mts',
  '.github/scripts/normalize-release-please-pr.sh',
  '.github/scripts/release-pr-identity.mts',
  'tools/release/publication-controller.mts',
  'tools/release/publication-controller.sh',
  'tools/release/release-bot.json',
  'tools/release/publish_swiftpm_source_tag.mts',
  'tools/release/publish-swiftpm-source-tag.sh',
  'tools/release/audit-github-release-controls.mts',
  'tools/release/fixtures/github-release-controls/desired-solo.json',
  'tools/release/fixtures/github-release-controls/desired-team.json',
  'tools/release/crates-io-bootstrap-capacity.mts',
  'tools/release/frozen-cargo-publish.mts',
  'tools/release/verify_github_release_attestations.mts',
  'tools/release/verify-github-release-attestations.sh',
]);

export function assertPublicationController({ source, controller, environment = process.env }) {
  return assertPublicationChanges({ source, controller, environment, checkout: true });
}

export function assertPublicationChanges({
  source,
  controller,
  environment = process.env,
  checkout = false,
}) {
  const proof = JSON.parse(environment.OLIPHAUNT_PUBLICATION_CONTROLLER_JSON || 'null');
  if (
    !proof ||
    proof.source !== source ||
    proof.controller !== controller ||
    !['checkout', 'changes'].includes(proof.mode) ||
    (checkout && proof.mode !== 'checkout')
  )
    throw new Error(
      'publication controller requires matching proof from publication-controller.sh',
    );
  return { source, controller };
}

function validateChanges(source, controller, mode, diff) {
  for (const sha of [source, controller]) {
    if (!/^[0-9a-f]{40}$/u.test(sha ?? ''))
      throw new Error('publication source and controller must be full commit SHAs');
  }
  if (!['checkout', 'changes'].includes(mode) || (diff && !diff.endsWith('\0')))
    throw new Error('invalid publication controller diff');
  const changed = diff.split('\0').filter(Boolean);
  const rejected = changed.filter(
    (file) =>
      !CONTROL_FILES.has(file) &&
      !/^tools\/(?:release|policy)\/[^/]+[.]test[.]m(?:j|t)s$/u.test(file) &&
      !/^docs\/maintainers\/release(?:-setup)?[.]md$/u.test(file),
  );
  if (rejected.length)
    throw new Error(
      `approved candidate cannot be reused after non-publication changes:\n${rejected.join('\n')}`,
    );
  return { source, controller, mode };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [source, controller, mode, file] = process.argv.slice(2);
    console.log(
      JSON.stringify(validateChanges(source, controller, mode, readFileSync(file, 'utf8'))),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

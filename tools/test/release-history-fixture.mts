import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
function run(name, options) {
  const module = [
    'verifyReleaseCommit',
    'deriveReleaseProducts',
    'latestVerifiedReleaseCommit',
  ].includes(name)
    ? 'verify-release-commit'
    : 'verify-publication-candidate';
  const result = spawnSync(
    process.env.OLIPHAUNT_TEST_BASH ?? 'bash',
    [
      'tools/release/with-release-history.sh',
      options.repo ?? root,
      options.headRef ?? 'HEAD',
      'bash',
      'tools/dev/bun.sh',
      '-e',
      'const [module, name, options] = process.argv.slice(1); const api = await import(module); console.log(JSON.stringify(api[name](JSON.parse(options))));',
      path.join(root, 'tools/release', module + '.mts'),
      name,
      JSON.stringify(options),
    ],
    { cwd: root, env: process.env, encoding: 'utf8', timeout: 30000 },
  );
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
  return JSON.parse(result.stdout);
}
export const verifyReleaseCommit = (options) => run('verifyReleaseCommit', options);
export const deriveReleaseProducts = (options) => run('deriveReleaseProducts', options);
export const latestVerifiedReleaseCommit = (options) => run('latestVerifiedReleaseCommit', options);
export const derivePublicationProducts = (options) => run('derivePublicationProducts', options);
export const resolvePublicationPlanningSource = (options) =>
  run('resolvePublicationPlanningSource', options);
export const verifyPublicationCandidate = (options) => run('verifyPublicationCandidate', options);

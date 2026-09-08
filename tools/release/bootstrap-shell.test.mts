import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bootstrapPublicationSchedule } from './bootstrap-publication-plan.mts';

const admittedPlan = Array.from({ length: 35 }, (_, index) => {
  const ecosystem = [1, 34].includes(index) ? 'npm' : 'cargo';
  const dependencies =
    index === 1
      ? ['cargo:p0']
      : index === 3
        ? ['npm:p1']
        : index >= 4
          ? ['cargo:p' + (index - 1)]
          : [];
  return {
    id: ecosystem + ':p' + index,
    name: 'p' + index,
    ecosystem,
    publishOrder: index,
    dependencies,
  };
});
test('bootstrap Shell isolates credentials, checkpoints batches, and preserves drained work after failure', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bootstrap-shell.'));
  for (const directory of ['.github/scripts', 'tools/dev', 'bin'])
    mkdirSync(path.join(root, directory), { recursive: true });
  copyFileSync(
    path.join(import.meta.dir, '../../.github/scripts/bootstrap-registry-identities.sh'),
    path.join(root, '.github/scripts/bootstrap-registry-identities.sh'),
  );
  mkdirSync(path.join(root, 'tools/release'), { recursive: true });
  writeFileSync(
    path.join(root, 'tools/release/with-source.sh'),
    '#!/usr/bin/env bash\nshift\nexec "$@"\n',
  );
  writeFileSync(
    path.join(root, 'plan.json'),
    JSON.stringify({ admittedPlan, dependencies: bootstrapPublicationSchedule(admittedPlan, []) }),
  );
  writeFileSync(
    path.join(root, 'tools/dev/bun.sh'),
    `#!/usr/bin/env bash
set -euo pipefail
phase="$2"; state="$3"; index="\${4:-}"
event() { echo "$*" >> "$BOOT_FIXTURE_LOG"; }
case "$phase" in
 --prepare) cp "$BOOT_FIXTURE_ROOT/plan.json" "$state/context.json" ;;
 --checkpoint)
  shopt -s nullglob; files=("$state"/operation-*.json); count="\${#files[@]}"
  event "checkpoint-$count"
  if [[ "$BOOT_FIXTURE_MODE" == checkpoint-failure && ! -f "$state/tried" ]]; then : > "$state/tried"; exit 9; fi
  echo "$count" > "$state/checkpoint-count" ;;
 --finish)
  if [[ -f "$state/status-1" && "$(cat "$state/status-1")" != 0 ]]; then
    [[ "$(cat "$state/status-1")" == 75 ]] || exit 9
    event deferred
  fi
  [[ ! -f "$state/checkpoint-failed" ]] || exit 9
  event finish ;;
 bootstrap-cargo)
  [[ -z "\${NPM_TOKEN:-}\${NPM_CONFIG_USERCONFIG:-}\${NODE_AUTH_TOKEN:-}" && "$CARGO_REGISTRY_TOKEN" == cargo-fixture ]]
  if [[ "$index" == 2 ]]; then
    event cargo-start; : > "$state/cargo-start"
    until [[ -f "$state/npm-start" ]]; do sleep 0.01; done
    sleep 0.15
    event cargo-drained
  fi
  echo '{}' > "$state/operation-$index.json"; event "cargo-$index" ;;
 bootstrap-npm-before)
  [[ -z "\${CARGO_REGISTRY_TOKEN:-}\${CRATES_IO_BOOTSTRAP_TOKEN:-}" && "$NPM_TOKEN" == npm-fixture ]]
  : > "$state/npm-start"
  if [[ "$index" == 1 && "$BOOT_FIXTURE_MODE" == deferral ]]; then
    until [[ -f "$state/cargo-start" ]]; do sleep 0.01; done
    event npm-deferred; exit 75
  fi
  jq -n '{tarball:"frozen.tgz",registry:"https://registry.npmjs.org",timeout:2000}' > "$state/npm-$index.json" ;;
 bootstrap-npm-after)
  if [[ "$index" == 1 ]]; then
    until [[ -f "$state/cargo-start" ]]; do sleep 0.01; done
    if [[ "$BOOT_FIXTURE_MODE" == mutation-failure ]]; then event npm-failed; exit 9; fi
  fi
  echo '{}' > "$state/operation-$index.json"; event "npm-$index" ;;
 *) exit 21 ;;
esac
`,
  );
  writeFileSync(
    path.join(root, 'bin/npm'),
    `#!/usr/bin/env bash
[[ "$*" == 'publish frozen.tgz --access public --provenance --registry https://registry.npmjs.org' && "$NPM_CONFIG_FETCH_RETRIES" == 0 ]] || exit 22
echo npm-publish >> "$BOOT_FIXTURE_LOG"
exit 7
`,
    { mode: 0o755 },
  );
  try {
    for (const mode of ['success', 'mutation-failure', 'deferral', 'checkpoint-failure']) {
      const log = path.join(root, mode + '.log');
      const result = spawnSync(
        'bash',
        [path.join(root, '.github/scripts/bootstrap-registry-identities.sh')],
        {
          env: {
            ...process.env,
            PATH: path.join(root, 'bin') + path.delimiter + process.env.PATH,
            BOOT_FIXTURE_ROOT: root,
            BOOT_FIXTURE_LOG: log,
            BOOT_FIXTURE_MODE: mode,
            RELEASE_HEAD_SHA: 'a'.repeat(40),
            PUBLICATION_LOCK_PATH: 'lock.json',
            BOOTSTRAP_LEDGER_PATH: 'ledger',
            CARGO_REGISTRY_TOKEN: 'cargo-fixture',
            CRATES_IO_BOOTSTRAP_TOKEN: 'cargo-fixture',
            NPM_TOKEN: 'npm-fixture',
            NODE_AUTH_TOKEN: 'npm-fixture',
            NPM_CONFIG_USERCONFIG: 'fixture-npmrc',
          },
          encoding: 'utf8',
          timeout: 15000,
        },
      );
      const events = readFileSync(log, 'utf8').trim().split('\n');
      expect(result.status === 0).toBe(['success', 'deferral'].includes(mode));
      expect(events).toContain('cargo-drained');
      const checkpoints = events.filter((event) => event.startsWith('checkpoint-'));
      if (mode === 'success') {
        expect(checkpoints.length).toBeGreaterThanOrEqual(2);
        expect(checkpoints.at(-1)).toBe('checkpoint-35');
      }
      if (mode === 'mutation-failure' || mode === 'deferral') {
        expect(events).not.toContain('cargo-3');
        expect(checkpoints.at(-1)).toBe('checkpoint-2');
        expect(events.indexOf('cargo-drained')).toBeLessThan(events.indexOf('checkpoint-2'));
      }
      if (mode === 'checkpoint-failure') {
        expect(checkpoints.length).toBeGreaterThanOrEqual(2);
        expect(events).not.toContain('finish');
      }
      if (mode === 'deferral') {
        expect(events).toContain('deferred');
        expect(events).not.toContain('npm-publish');
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

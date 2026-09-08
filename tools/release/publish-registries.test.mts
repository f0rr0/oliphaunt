import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalPublicationSchedule } from './normal-publication-executor.mts';

const operations = ['cargo', 'npm', 'cargo', 'maven', 'npm'].map((ecosystem, operationOrder) => ({
  id: 'op' + operationOrder,
  ecosystem,
  operationOrder,
  dependencies: [[], ['op0'], ['op1'], ['op1'], ['op2', 'op3']][operationOrder],
  ...(ecosystem === 'maven'
    ? { kind: 'maven-atomic-deployment', carrierIds: ['maven:fixture'] }
    : { kind: 'carrier', carrierId: ecosystem + ':fixture-' + operationOrder }),
}));
const plan = { operations };
test('Shell registry lanes preserve dependencies, reconcile one npm attempt, and drain active peers', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'registry-shell.'));
  mkdirSync(path.join(root, 'tools/release'), { recursive: true });
  mkdirSync(path.join(root, 'tools/dev'), { recursive: true });
  mkdirSync(path.join(root, 'bin'));
  copyFileSync(
    path.join(import.meta.dir, 'publish-registries.sh'),
    path.join(root, 'tools/release/publish-registries.sh'),
  );
  const schedule = normalPublicationSchedule(plan);
  expect(schedule.cargoBatches).toEqual([[0], [2]]);
  mkdirSync(path.join(root, 'tools/release'), { recursive: true });
  writeFileSync(
    path.join(root, 'tools/release/with-source.sh'),
    '#!/usr/bin/env bash\nshift\nexec "$@"\n',
  );
  writeFileSync(path.join(root, 'plan.json'), JSON.stringify({ plan, schedule }));
  writeFileSync(
    path.join(root, 'tools/dev/bun.sh'),
    `#!/usr/bin/env bash
set -euo pipefail
phase="$2"; state="$3"; index="\${4:-}"
event() { echo "$*" >> "$REGISTRY_FIXTURE_LOG"; }
case "$phase" in
 registry-prepare) cp "$REGISTRY_FIXTURE_ROOT/plan.json" "$state/context.json" ;;
 registry-cargo)
  if [[ "$index" == 0 ]]; then echo '[]' > "$state/operation-0.json"; event cargo-0; else
   [[ -f "$state/operation-1.json" ]]
   event cargo-start; : > "$state/cargo-start"
   until [[ -f "$state/maven-start" ]]; do sleep 0.05; done
   sleep 0.15
   echo '[]' > "$state/operation-2.json"; event cargo-drained
  fi ;;
 registry-npm-before)
  event "npm-before-$index"
  jq -n '{tarball:"frozen.tgz",registry:"https://registry.npmjs.org",timeout:2000}' > "$state/npm-$index.json" ;;
 registry-npm-after) event "npm-reconciled-$index"; echo '[]' > "$state/operation-$index.json" ;;
 registry-maven)
  [[ -f "$state/operation-1.json" ]]
  until [[ -f "$state/cargo-start" ]]; do sleep 0.05; done
  event maven-start; : > "$state/maven-start"
  [[ "$REGISTRY_FIXTURE_FAIL" != true ]] || exit 9
  echo '[]' > "$state/operation-3.json" ;;
 registry-finish) event finish ;;
 *) exit 20 ;;
esac
`,
  );
  writeFileSync(
    path.join(root, 'bin/npm'),
    `#!/usr/bin/env bash
[[ "$*" == 'publish frozen.tgz --access public --provenance --registry https://registry.npmjs.org' ]] || exit 21
[[ "$NPM_CONFIG_FETCH_RETRIES" == 0 ]] || exit 22
echo npm-push >> "$REGISTRY_FIXTURE_LOG"
exit 7
`,
    { mode: 0o755 },
  );
  try {
    for (const fail of [false, true]) {
      const log = path.join(root, 'events-' + fail);
      const result = spawnSync(
        'bash',
        [path.join(root, 'tools/release/publish-registries.sh'), '--products-json', '["fixture"]'],
        {
          env: {
            ...process.env,
            PATH: path.join(root, 'bin') + path.delimiter + process.env.PATH,
            REGISTRY_FIXTURE_ROOT: root,
            REGISTRY_FIXTURE_LOG: log,
            REGISTRY_FIXTURE_FAIL: String(fail),
          },
          encoding: 'utf8',
          timeout: 10000,
        },
      );
      const events = readFileSync(log, 'utf8').trim().split('\n');
      expect(result.status === 0).toBe(!fail);
      expect(events.indexOf('cargo-0')).toBeLessThan(events.indexOf('npm-before-1'));
      expect(events.indexOf('npm-reconciled-1')).toBeLessThan(events.indexOf('maven-start'));
      expect(events.indexOf('maven-start')).toBeLessThan(events.indexOf('cargo-drained'));
      expect(events).toContain('cargo-drained');
      expect(events.includes('npm-before-4')).toBe(!fail);
      expect(events.includes('finish')).toBe(!fail);
      expect(events.filter((event) => event === 'npm-push').length).toBe(fail ? 1 : 2);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

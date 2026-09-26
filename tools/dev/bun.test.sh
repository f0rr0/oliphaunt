#!/usr/bin/env bash
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
cat > "$scratch/timeout.test.mts" <<'TS'
import { expect, test } from 'bun:test';
test('uses the requested working directory and exceeds Bun’s five-second default', async () => {
  expect(await Bun.file('timeout.test.mts').exists()).toBe(true);
  await Bun.sleep(5100);
});
TS
cd "$scratch"
bash "$root/tools/dev/bun.sh" test --cwd "$scratch" ./timeout.test.mts
for timeout in --timeout=10 '--timeout 10'; do
  # Deliberately split the two supported CLI spellings.
  if bash "$root/tools/dev/bun.sh" test $timeout --cwd "$scratch" ./timeout.test.mts > "$scratch/result" 2>&1; then
    echo 'Explicit test timeout was ignored' >&2
    exit 1
  fi
  grep -q 'timed out after 10ms' "$scratch/result"
done
echo 'Bun launcher: shared timeout, explicit overrides and package working directory passed'

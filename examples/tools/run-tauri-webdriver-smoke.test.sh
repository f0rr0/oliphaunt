#!/usr/bin/env bash
set -euo pipefail
if [ "$(uname -s)" != Linux ]; then
  echo 'Tauri WebDriver process cleanup check requires Linux'
  exit 0
fi
root="$(git rev-parse --show-toplevel)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
export TAURI_DRIVER_PROOF="$scratch"

cat > "$scratch/driver" <<'DRIVER'
#!/usr/bin/env bash
set -euo pipefail
sleep 300 &
echo "$!" > "$TAURI_DRIVER_PROOF/descendant"
exec node "$TAURI_DRIVER_PROOF/driver.mts" "$@"
DRIVER
chmod +x "$scratch/driver"
cat > "$scratch/driver.mts" <<'DRIVER'
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
const proof = process.env.TAURI_DRIVER_PROOF;
writeFileSync(`${proof}/profile`, process.env.XDG_DATA_HOME);
createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  let value = {};
  if (request.method === 'POST' && request.url === '/session') {
    assert.equal(body.capabilities.alwaysMatch['tauri:options'].application, '/test/application');
    value = { sessionId: 'test' };
  } else if (request.url.endsWith('/element')) {
    value = process.env.FAIL_SMOKE === '1'
      ? { error: 'no such element' }
      : { 'element-6066-11e4-a52e-4f735466cecf': 'element' };
  } else if (request.url.endsWith('/execute/sync')) {
    value = 'created by raw WebDriver';
  } else if (request.method === 'DELETE' && request.url === '/session/test') {
    writeFileSync(`${proof}/deleted`, 'yes');
  }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ value }));
}).listen(Number(process.argv[3]), '127.0.0.1');
DRIVER

for failure in 0 1; do
  rm -f "$scratch/deleted"
  status=0
  FAIL_SMOKE="$failure" bash "$root/examples/tools/run-tauri-webdriver-smoke.sh" \
    --run-built "$scratch/driver" /test/application > "$scratch/output" 2>&1 || status=$?
  if { [ "$failure" = 0 ] && [ "$status" != 0 ]; } ||
     { [ "$failure" = 1 ] && [ "$status" = 0 ]; }; then
    cat "$scratch/output" >&2
    exit 1
  fi
  test -f "$scratch/deleted"
  test ! -e "$(cat "$scratch/profile")"
  descendant="$(cat "$scratch/descendant")"
  # An orphan can briefly remain as a zombie until the host reaps it.
  state="$(ps -o stat= -p "$descendant" || true)"
  [[ -z "$state" || "$state" = Z* ]]
done
echo 'Tauri WebDriver session, profile and descendant cleanup passed on success and failure'

#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
source_root="$PWD"
bun test ./tools/release/trusted-publisher-config.test.mts
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
bun tools/release/trusted-publisher-config.test.mts pipe | cat > "$scratch/pipe.json"
bun tools/release/trusted-publisher-config.test.mts assert-pipe "$scratch/pipe.json"
if [[ "$(uname -s)" != Linux ]]; then
  echo 'Trusted publisher: JSON pipe passed; Linux script(1) terminal test not run on this host'
  exit 0
fi
mkdir "$scratch/bin"
printf '#!/usr/bin/env bash\n[ "$1" = 2 ]\n' > "$scratch/bin/sleep"
cat > "$scratch/bin/npm" <<'SH'
#!/usr/bin/env bash
set -eu
if [ "$1" = --version ]; then echo 11.15.0; exit; fi
[ "$1" = trust ]
printf '%s %s %s\n' "$2" "$3" "$NPM_CONFIG_FETCH_RETRIES" >> "$TEST_EVENTS"
if [ "$2" = list ]; then
  [ "$#" = 6 ] && [ "$4" = --json ] && [ "$5" = --registry ] && [ "$6" = https://registry.npmjs.org/ ]
  [ "$NPM_CONFIG_FETCH_RETRIES" = 3 ]
  if [ -t 1 ]; then [ -t 0 ]; echo 'discard this authentication display'; exit; fi
  if [ "$TEST_SCENARIO" = conflict ]; then echo "$TEST_CONFLICT"; exit; fi
  if [ -f "$TEST_STATE" ]; then echo "$TEST_EXACT"; else echo '[]'; fi
elif [ "$2" = github ]; then
  [ -t 0 ] && [ -t 1 ]
  [ "$NPM_CONFIG_FETCH_RETRIES" = 0 ]
  [ "$*" = 'trust github @oliphaunt/example --file release.yml --repo f0rr0/oliphaunt --env release-publish --allow-publish --yes --json --registry https://registry.npmjs.org/' ]
  if [ "$TEST_SCENARIO" != missing ]; then touch "$TEST_STATE"; fi
  exit 7
else exit 91; fi
SH
chmod +x "$scratch/bin/"*
export SHELL=/bin/bash BASH_ENV=/dev/null PATH="$scratch/bin:$PATH"
export TEST_SHELL="$source_root/tools/release/trusted-publisher-config.sh" TEST_ROOT="$scratch"
invoke() {
  status=0
  timeout 15 script --return --quiet --command 'bash "$TEST_SHELL" --npm "$TEST_ROOT"' /dev/null > "$scratch/result" 2>&1 || status=$?
}
for scenario in ambiguous rerun conflict missing; do
  bun tools/release/trusted-publisher-config.test.mts prepare "$scratch" "$scenario"
  export TEST_EVENTS="$scratch/$scenario.events" TEST_STATE="$scratch/$scenario.state" TEST_SCENARIO="$scenario"
  export TEST_EXACT="$(cat "$scratch/exact.json")" TEST_CONFLICT="$(cat "$scratch/conflicting.json")"
  invoke
  expected=0
  [[ "$scenario" != conflict ]] || expected=1
  [[ "$scenario" != missing ]] || expected=2
  if [[ "$status" != "$expected" ]]; then cat "$scratch/result" >&2; exit 1; fi
  bun tools/release/trusted-publisher-config.test.mts assert "$scratch" "$scenario"
  if [[ "$scenario" == missing ]]; then continue; fi
  cp "$scratch/$scenario.json" "$scratch/before.json"
  cp "$TEST_EVENTS" "$scratch/before.events"
  invoke
  [[ "$status" != 0 && "$status" != 124 ]]
  cmp "$scratch/before.json" "$scratch/$scenario.json"
  cmp "$scratch/before.events" "$TEST_EVENTS"
done
echo 'Trusted publisher: complete pipe output, terminal auth, conflict blocking and one-mutation reconciliation passed'

#!/usr/bin/env bash
set -euo pipefail
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
export MOON_BIN="$fixture/moon" MOON_CALLS="$fixture/calls"
cat >"$MOON_BIN" <<'MOON'
#!/usr/bin/env bash
if [[ -v MOON_BASE || -v MOON_HEAD ]]; then
  echo 'explicit task execution inherited affectedness revisions' >&2
  exit 8
fi
printf '%s\n' "$*" >>"$MOON_CALLS"
exit "${MOON_TEST_EXIT:-0}"
MOON
chmod +x "$MOON_BIN"
MOON_BASE=missing-base MOON_HEAD=missing-head \
  bash .github/scripts/run-moon-targets.sh ci-workflows:verify-bash
printf 'run ci-workflows:verify-bash\n' >"$fixture/expected"
cmp "$MOON_CALLS" "$fixture/expected"
: >"$MOON_CALLS"
export MOON_TARGET_MATRIX_JSON='{"include":[{"target":"sdk:b"},{"target":"sdk:a"},{"target":"sdk:a"},{"target":"native:c","upstream":"none"}]}'
bash .github/scripts/run-moon-targets.sh --matrix
printf 'run --upstream deep sdk:a sdk:b\nrun --upstream none native:c\n' >"$fixture/expected"
cmp "$MOON_CALLS" "$fixture/expected"
: >"$MOON_CALLS"
if MOON_TEST_EXIT=7 bash .github/scripts/run-moon-targets.sh --matrix; then
  echo 'Moon failure was ignored' >&2
  exit 1
fi
printf 'run --upstream deep sdk:a sdk:b\n' >"$fixture/expected"
cmp "$MOON_CALLS" "$fixture/expected"
: >"$MOON_CALLS"
if MOON_TARGET_MATRIX_JSON='{"include":[{"target":"sdk:a"},{"target":"-bad target"}]}' \
  bash .github/scripts/run-moon-targets.sh --matrix; then
  echo 'invalid target was accepted' >&2
  exit 1
fi
[ ! -s "$MOON_CALLS" ]

# Selected package roots must finish before consumers; downloaded producers never run.
cat >"$fixture/graph.json" <<'GRAPH'
{"data":{"package":{"target":"sdk:z-package","deps":[{"target":"native:ios","cacheStrategy":"hash"},{"target":"sdk:build","cacheStrategy":"hash"},{"target":"sdk:cargo-sources","cacheStrategy":"hash"}]},"consumer":{"target":"sdk:a-consumer","deps":[{"target":"sdk:z-package"}]},"build":{"target":"sdk:build","deps":[]},"native":{"target":"native:ios","deps":[]},"sources":{"target":"sdk:cargo-sources","command":"noop","deps":[],"options":{"internal":true}}}}
GRAPH
export MOON_TEST_GRAPH="$fixture/graph.json"
cat >"$MOON_BIN" <<'MOON'
#!/usr/bin/env bash
if [ "$1" = task-graph ]; then cat "$MOON_TEST_GRAPH"; exit; fi
if [[ "$*" == 'run --upstream none '* && "${MOON_CACHE:-}" != off ]]; then
  echo 'transferred consumers must execute without incomplete dependency cache keys' >&2
  exit 9
fi
printf '%s\n' "$*" >>"$MOON_CALLS"
if [ "${MOON_FAIL_TARGET:-}" = "${*: -1}" ]; then exit 7; fi
MOON
export OLIPHAUNT_CI_JOB_TARGETS_JSON='{"fixture":["sdk:a-consumer","sdk:z-package"]}'
export OLIPHAUNT_MOON_TRANSFERRED_DEPS_JSON='["native:ios"]'
bash .github/scripts/run-planned-moon-job.sh fixture
printf 'run sdk:build\nrun --upstream none sdk:z-package\nrun --upstream none sdk:a-consumer\n' >"$fixture/expected"
cmp "$MOON_CALLS" "$fixture/expected"
: >"$MOON_CALLS"
if MOON_FAIL_TARGET=sdk:z-package bash .github/scripts/run-planned-moon-job.sh fixture; then
  echo 'failed package reached its consumer' >&2
  exit 1
fi
printf 'run sdk:build\nrun --upstream none sdk:z-package\n' >"$fixture/expected"
cmp "$MOON_CALLS" "$fixture/expected"

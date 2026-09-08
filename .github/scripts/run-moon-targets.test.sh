#!/usr/bin/env bash
set -euo pipefail
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
export MOON_BIN="$fixture/moon" MOON_CALLS="$fixture/calls"
cat >"$MOON_BIN" <<'MOON'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$MOON_CALLS"
exit "${MOON_TEST_EXIT:-0}"
MOON
chmod +x "$MOON_BIN"
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

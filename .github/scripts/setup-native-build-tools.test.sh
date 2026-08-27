#!/usr/bin/env bash
# Shell fragments are intentionally single-quoted so the generated shims, not
# this fixture, expand their variables.
# shellcheck disable=SC2016
set -euo pipefail

fail() {
  echo "setup-native-build-tools.test.sh: $*" >&2
  exit 1
}

root="$(git rev-parse --show-toplevel)"
installer="$root/.github/scripts/setup-native-build-tools.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
mkdir -p "$tmp/bin"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  '[ "${1:-}" = "-s" ] || exit 2' \
  'printf "Linux\n"' >"$tmp/bin/uname"

for compiler in gcc-12 g++-12; do
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    'case " $* " in' \
    '  *" -dumpfullversion "*) printf "12.4.0\n" ;;' \
    '  *) exit 2 ;;' \
    'esac' >"$tmp/bin/$compiler"
done

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'printf "%s\n" "$*" >>"$CCACHE_CALL_LOG"' >"$tmp/bin/ccache"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'printf "%s\n" "$*" >>"$SLEEP_CALL_LOG"' >"$tmp/bin/sleep"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  ': "${APT_CALL_LOG:?}" "${APT_INSTALL_ATTEMPTS:?}" "${APT_INSTALL_FAILURES:?}"' \
  'if [ "${1:-}" != "apt-get" ]; then exit 0; fi' \
  'shift' \
  'printf "<CALL>" >>"$APT_CALL_LOG"' \
  'for argument in "$@"; do printf " <%s>" "$argument" >>"$APT_CALL_LOG"; done' \
  'printf "\n" >>"$APT_CALL_LOG"' \
  'operation=""' \
  'has_no_upgrade=0' \
  'for argument in "$@"; do' \
  '  case "$argument" in' \
  '    update | install) operation="$argument" ;;' \
  '    --no-upgrade) has_no_upgrade=1 ;;' \
  '  esac' \
  'done' \
  '[ -n "$operation" ] || exit 3' \
  'if [ "$operation" = "update" ]; then exit 0; fi' \
  '[ "$has_no_upgrade" = "1" ] || exit 88' \
  'attempt="$(cat "$APT_INSTALL_ATTEMPTS")"' \
  'attempt=$((attempt + 1))' \
  'printf "%s\n" "$attempt" >"$APT_INSTALL_ATTEMPTS"' \
  'if [ "$attempt" -le "$APT_INSTALL_FAILURES" ]; then exit 100; fi' >"$tmp/bin/sudo"

chmod 0555 "$tmp/bin/uname" "$tmp/bin/gcc-12" "$tmp/bin/g++-12" \
  "$tmp/bin/ccache" "$tmp/bin/sleep" "$tmp/bin/sudo"

run_installer() {
  local failures="$1"
  env \
    "APT_CALL_LOG=$tmp/apt-calls.log" \
    "APT_INSTALL_ATTEMPTS=$tmp/apt-install-attempts" \
    "APT_INSTALL_FAILURES=$failures" \
    "CCACHE_CALL_LOG=$tmp/ccache-calls.log" \
    "CCACHE_DIR=$tmp/ccache" \
    "OLIPHAUNT_CCACHE_ZERO_STATS=1" \
    "PATH=$tmp/bin:/usr/bin:/bin" \
    "SLEEP_CALL_LOG=$tmp/sleep-calls.log" \
    bash "$installer"
}

reset_fixture() {
  : >"$tmp/apt-calls.log"
  printf '0\n' >"$tmp/apt-install-attempts"
  : >"$tmp/ccache-calls.log"
  : >"$tmp/sleep-calls.log"
}

# A failed install refreshes the package indexes before retrying the complete
# transaction. Every install must suppress opportunistic upgrades of tools
# already present in the hosted runner image.
reset_fixture
run_installer 1 >"$tmp/retry.out" 2>"$tmp/retry.err"
[ "$(cat "$tmp/apt-install-attempts")" = "2" ] || fail "retry did not perform two install attempts"
[ "$(grep -c '<update>' "$tmp/apt-calls.log")" = "2" ] || fail "retry did not refresh package indexes"
[ "$(grep -c '<install>' "$tmp/apt-calls.log")" = "2" ] || fail "retry install count mismatch"
[ "$(grep -c '<--no-upgrade>' "$tmp/apt-calls.log")" = "2" ] || fail "apt install omitted --no-upgrade"
[ "$(cat "$tmp/sleep-calls.log")" = "15" ] || fail "first retry backoff mismatch"
grep -Fq 'retrying apt tool installation after attempt 1/3' "$tmp/retry.err" ||
  fail "retry diagnostic missing"
grep -Fq 'Pinned Linux native compiler contract: 12.4.0 / 12.4.0' "$tmp/retry.out" ||
  fail "compiler contract was not checked after retry"

# A persistent repository failure stays bounded and fails closed after three
# refreshed attempts instead of continuing with an incomplete toolchain.
reset_fixture
if run_installer 3 >"$tmp/failure.out" 2>"$tmp/failure.err"; then
  fail "persistent apt failure unexpectedly succeeded"
fi
[ "$(cat "$tmp/apt-install-attempts")" = "3" ] || fail "persistent failure was not bounded at three attempts"
[ "$(grep -c '<update>' "$tmp/apt-calls.log")" = "3" ] || fail "persistent retries did not refresh indexes"
[ "$(grep -c '<install>' "$tmp/apt-calls.log")" = "3" ] || fail "persistent install count mismatch"
[ "$(grep -c '<--no-upgrade>' "$tmp/apt-calls.log")" = "3" ] || fail "persistent installs omitted --no-upgrade"
[ "$(cat "$tmp/sleep-calls.log")" = $'15\n30' ] || fail "bounded retry backoff mismatch"
grep -Fq 'apt tool installation failed after 3 attempts' "$tmp/failure.err" ||
  fail "terminal apt diagnostic missing"

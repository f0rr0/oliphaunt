#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
helper="$root/src/extensions/external/postgis/tools/reproducible-time.sh"
shim="$root/src/extensions/external/postgis/tools/reproducible-bin/date"
expected_epoch=1776193981
expected_utc='2026-04-14 19:13:01'
test_root="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-postgis-time-test.XXXXXX")"
original_path="$PATH"
cleanup() {
  rm -rf "$test_root"
}
trap cleanup EXIT

fail() {
  echo "PostGIS reproducible time test failed: $*" >&2
  exit 1
}

. "$helper"

actual_epoch="$(SOURCE_DATE_EPOCH=111 oliphaunt_postgis_source_date_epoch "$root")"
[ "$actual_epoch" = "$expected_epoch" ] ||
  fail "canonical manifest epoch changed: $actual_epoch"
second_epoch="$(SOURCE_DATE_EPOCH=222 oliphaunt_postgis_source_date_epoch "$root")"
[ "$second_epoch" = "$expected_epoch" ] ||
  fail "ambient SOURCE_DATE_EPOCH overrode the canonical manifest"

fake_root="$test_root/repository"
fake_manifest="$fake_root/src/extensions/external/postgis/source.toml"
mkdir -p "$(dirname "$fake_manifest")"
printf 'name = "postgis"\n' > "$fake_manifest"
if oliphaunt_postgis_source_date_epoch "$fake_root" >"$test_root/missing.out" 2>"$test_root/missing.err"; then
  fail "missing source_date_epoch was accepted"
fi
grep -Fq 'exactly one canonical source_date_epoch' "$test_root/missing.err" ||
  fail "missing-key error was not actionable"

printf 'source_date_epoch = "1776193981"\n' > "$fake_manifest"
if oliphaunt_postgis_source_date_epoch "$fake_root" >"$test_root/quoted.out" 2>"$test_root/quoted.err"; then
  fail "quoted source_date_epoch was accepted"
fi
grep -Fq 'canonical positive integer' "$test_root/quoted.err" ||
  fail "noncanonical-value error was not actionable"

printf 'source_date_epoch = 1776193981\nsource_date_epoch = 1776193981\n' > "$fake_manifest"
if oliphaunt_postgis_source_date_epoch "$fake_root" >"$test_root/duplicate.out" 2>"$test_root/duplicate.err"; then
  fail "duplicate source_date_epoch was accepted"
fi
grep -Fq 'exactly one canonical source_date_epoch' "$test_root/duplicate.err" ||
  fail "duplicate-key error was not actionable"

printf 'source_date_epoch = 253402300800\n' > "$fake_manifest"
if oliphaunt_postgis_source_date_epoch "$fake_root" >"$test_root/range.out" 2>"$test_root/range.err"; then
  fail "out-of-range source_date_epoch was accepted"
fi
grep -Fq 'exceeds the portable UTC range' "$test_root/range.err" ||
  fail "out-of-range error was not actionable"

fake_bin="$test_root/fake-bsd-bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/date" <<'EOF'
#!/usr/bin/env bash
if printf '%s\n' "$@" | grep -Fxq -- -d; then
  echo 'BSD date does not support -d' >&2
  exit 64
fi
printf 'delegated:%s\n' "$*"
EOF
chmod +x "$fake_bin/date"

export PATH="$fake_bin:$original_path"
export OLIPHAUNT_POSTGIS_REAL_DATE=/bin/false
export SOURCE_DATE_EPOCH=333
oliphaunt_postgis_enable_reproducible_time "$root"
[ "$SOURCE_DATE_EPOCH" = "$expected_epoch" ] ||
  fail "enable helper retained ambient SOURCE_DATE_EPOCH"
[ "$(command -v date)" = "$shim" ] ||
  fail "portable date shim was not placed first on PATH"
[ "$(date -d "@$SOURCE_DATE_EPOCH" -u '+%Y-%m-%d %H:%M:%S')" = "$expected_utc" ] ||
  fail "GNU-order PostGIS date invocation was not deterministic"
[ "$(date -u -d "@$SOURCE_DATE_EPOCH" '+%Y-%m-%d %H:%M:%S')" = "$expected_utc" ] ||
  fail "alternate GNU date argument order was not deterministic"
[ "$(date '+%Y/%m/%d')" = 'delegated:+%Y/%m/%d' ] ||
  fail "unrelated date invocation was not delegated to the host command"

oliphaunt_postgis_enable_reproducible_time "$root"
[ "$OLIPHAUNT_POSTGIS_REAL_DATE" = "$fake_bin/date" ] ||
  fail "repeated enable did not retain the originally captured host date command"
[ "$(date '+%Y/%m/%d')" = 'delegated:+%Y/%m/%d' ] ||
  fail "repeated enable broke delegation to the captured host command"

printf 'PostGIS reproducible time tests passed\n'

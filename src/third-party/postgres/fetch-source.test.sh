#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$script_dir/fetch-source.sh"

fail() {
  echo "fetch-source.test.sh: $*" >&2
  exit 1
}

sha256_file() {
  oliphaunt_postgresql_sha256_file "$1"
}

assert_verified_file() {
  local path="$1"
  local expected="$2"
  [[ -f "$path" ]] || fail "missing verified destination $path"
  [[ "$(sha256_file "$path")" == "$expected" ]] || fail "unexpected checksum for $path"
}

assert_no_partials() {
  local root="$1"
  local partial
  partial="$(find "$root" -type f -name '*.partial.*' -print -quit)"
  [[ -z "$partial" ]] || fail "partial transport file was not removed: $partial"
}

assert_transport_flags() {
  local log="$1"
  for expected in \
    '--location' \
    '--fail' \
    '--retry 4' \
    '--retry-all-errors' \
    '--retry-delay 3' \
    '--retry-max-time 90' \
    '--connect-timeout 20' \
    '--max-time 60' \
    '--max-filesize 67108864' \
    '--proto =https' \
    '--proto-redir =https' \
    '--tlsv1.2'; do
    grep -F -- "$expected" "$log" >/dev/null || fail "curl invocation omitted $expected"
  done
}

work_root="$(mktemp -d)"
cleanup() {
  rm -rf "$work_root"
}
trap cleanup EXIT HUP INT TERM

fixture="$work_root/postgresql-18.4.tar.bz2"
printf 'verified PostgreSQL source fixture\n' > "$fixture"
fixture_sha="$(sha256_file "$fixture")"
fake_bin="$work_root/fake-bin"
mkdir -p "$fake_bin"
cp "$script_dir/testdata/curl" "$fake_bin/curl"
chmod 0755 "$fake_bin/curl"
fake_path="$fake_bin:$PATH"
primary_url="https://primary.invalid/postgresql-18.4.tar.bz2"
fallback_url="https://fossies.org/linux/misc/postgresql-18.4.tar.bz2"

cached_destination="$work_root/cached/postgresql-18.4.tar.bz2"
mkdir -p "$(dirname "$cached_destination")"
cp "$fixture" "$cached_destination"
cached_log="$work_root/cached-curl.log"
OLIPHAUNT_FETCH_TEST_LOG="$cached_log" \
OLIPHAUNT_FETCH_TEST_MODE=all-fail \
OLIPHAUNT_FETCH_TEST_FIXTURE="$fixture" \
PATH="$fake_path" \
  oliphaunt_fetch_postgresql_source_archive "$cached_destination" 18.4 "$fixture_sha" "$primary_url"
[[ ! -e "$cached_log" ]] || fail "verified cached source unexpectedly used curl"
assert_verified_file "$cached_destination" "$fixture_sha"

fallback_destination="$work_root/fallback/postgresql-18.4.tar.bz2"
mkdir -p "$(dirname "$fallback_destination")"
printf 'corrupt cached bytes\n' > "$fallback_destination"
fallback_log="$work_root/fallback-curl.log"
OLIPHAUNT_FETCH_TEST_LOG="$fallback_log" \
OLIPHAUNT_FETCH_TEST_MODE=primary-fails \
OLIPHAUNT_FETCH_TEST_FIXTURE="$fixture" \
OLIPHAUNT_FETCH_TEST_FINAL="$fallback_destination" \
PATH="$fake_path" \
  oliphaunt_fetch_postgresql_source_archive "$fallback_destination" 18.4 "$fixture_sha" "$primary_url"
assert_verified_file "$fallback_destination" "$fixture_sha"
[[ "$(wc -l < "$fallback_log" | tr -d ' ')" == 2 ]] || fail "transport did not try exactly the primary and fallback URLs"
grep -F -- "$primary_url" "$fallback_log" >/dev/null || fail "primary URL was not attempted"
grep -F -- "$fallback_url" "$fallback_log" >/dev/null || fail "fallback URL was not attempted"
assert_transport_flags "$fallback_log"
assert_no_partials "$work_root/fallback"

checksum_destination="$work_root/checksum/postgresql-18.4.tar.bz2"
checksum_log="$work_root/checksum-curl.log"
OLIPHAUNT_FETCH_TEST_LOG="$checksum_log" \
OLIPHAUNT_FETCH_TEST_MODE=primary-has-wrong-checksum \
OLIPHAUNT_FETCH_TEST_FIXTURE="$fixture" \
OLIPHAUNT_FETCH_TEST_FINAL="$checksum_destination" \
PATH="$fake_path" \
  oliphaunt_fetch_postgresql_source_archive "$checksum_destination" 18.4 "$fixture_sha" "$primary_url"
assert_verified_file "$checksum_destination" "$fixture_sha"
[[ "$(wc -l < "$checksum_log" | tr -d ' ')" == 2 ]] || fail "checksum mismatch did not advance exactly once to the fallback"
assert_no_partials "$work_root/checksum"

failed_destination="$work_root/failed/postgresql-18.4.tar.bz2"
failed_log="$work_root/failed-curl.log"
if OLIPHAUNT_FETCH_TEST_LOG="$failed_log" \
  OLIPHAUNT_FETCH_TEST_MODE=all-fail \
  OLIPHAUNT_FETCH_TEST_FIXTURE="$fixture" \
  OLIPHAUNT_FETCH_TEST_FINAL="$failed_destination" \
  PATH="$fake_path" \
    oliphaunt_fetch_postgresql_source_archive "$failed_destination" 18.4 "$fixture_sha" "$primary_url" >/dev/null 2>&1; then
  fail "all-failed transport unexpectedly succeeded"
fi
[[ ! -e "$failed_destination" ]] || fail "failed transport promoted an unverified final destination"
[[ "$(wc -l < "$failed_log" | tr -d ' ')" == 2 ]] || fail "failed transport exceeded or skipped the two bounded URL attempts"
assert_no_partials "$work_root/failed"

interrupted_destination="$work_root/interrupted/postgresql-18.4.tar.bz2"
interrupted_log="$work_root/interrupted-curl.log"
if OLIPHAUNT_FETCH_TEST_LOG="$interrupted_log" \
  OLIPHAUNT_FETCH_TEST_MODE=interrupt-parent \
  OLIPHAUNT_FETCH_TEST_FIXTURE="$fixture" \
  OLIPHAUNT_FETCH_TEST_FINAL="$interrupted_destination" \
  PATH="$fake_path" \
    oliphaunt_fetch_postgresql_source_archive "$interrupted_destination" 18.4 "$fixture_sha" "$primary_url" >/dev/null 2>&1; then
  fail "interrupted transport unexpectedly succeeded"
fi
[[ ! -e "$interrupted_destination" ]] || fail "interrupted transport promoted an unverified final destination"
[[ "$(wc -l < "$interrupted_log" | tr -d ' ')" == 1 ]] || fail "interrupted transport continued to a fallback URL"
assert_no_partials "$work_root/interrupted"

rejected_log="$work_root/rejected-curl.log"
if OLIPHAUNT_FETCH_TEST_LOG="$rejected_log" \
  OLIPHAUNT_FETCH_TEST_MODE=all-fail \
  OLIPHAUNT_FETCH_TEST_FIXTURE="$fixture" \
  PATH="$fake_path" \
    oliphaunt_fetch_postgresql_source_archive "$work_root/rejected/archive" 18.4 "$fixture_sha" http://primary.invalid/postgresql-18.4.tar.bz2 >/dev/null 2>&1; then
  fail "non-HTTPS primary URL unexpectedly succeeded"
fi
[[ ! -e "$rejected_log" ]] || fail "non-HTTPS URL reached curl"

if oliphaunt_fetch_postgresql_source_archive "$work_root/rejected/archive" 18.4 not-a-sha "$primary_url" >/dev/null 2>&1; then
  fail "invalid SHA-256 unexpectedly succeeded"
fi
if oliphaunt_fetch_postgresql_source_archive "$work_root/rejected/archive" '../18.4' "$fixture_sha" "$primary_url" >/dev/null 2>&1; then
  fail "invalid PostgreSQL version unexpectedly succeeded"
fi

echo "PostgreSQL source fetch transport tests passed"

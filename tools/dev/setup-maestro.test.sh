#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
installer="$root/tools/dev/setup-maestro.sh"
manifest="$root/src/sources/toolchains/maestro.toml"
configured_version="$(sed -n 's/^[[:space:]]*maestro[[:space:]]*=[[:space:]]*"\([^"]*\)"[[:space:]]*$/\1/p' "$manifest")"
expected_version="${configured_version#cli-}"
expected_sha256="$(sed -n 's/^[[:space:]]*sha256[[:space:]]*=[[:space:]]*"\([^"]*\)"[[:space:]]*$/\1/p' "$manifest")"
expected_url="$(sed -n 's/^[[:space:]]*install_url[[:space:]]*=[[:space:]]*"\([^"]*\)"[[:space:]]*$/\1/p' "$manifest")"
if [ -z "$expected_version" ] || [ -z "$expected_sha256" ] || [ -z "$expected_url" ]; then
  echo "setup-maestro.test.sh: missing Maestro release metadata in $manifest" >&2
  exit 1
fi
test_root="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-maestro-test.XXXXXX")"
trap 'rm -rf "$test_root"' EXIT

fail() {
  echo "setup-maestro.test.sh: $*" >&2
  exit 1
}

assert_contains() {
  local path="$1"
  local expected="$2"
  grep -F -- "$expected" "$path" >/dev/null || fail "$path did not contain: $expected"
}

assert_curl_arg() {
  local path="$1"
  local expected="$2"
  grep -Fx -- "$expected" "$path" >/dev/null || fail "curl did not receive argument: $expected"
}

fake_bin="$test_root/fake-bin"
mkdir -p "$fake_bin"

cat >"$fake_bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"$MAESTRO_TEST_CURL_ARGS"
if [ "${MAESTRO_TEST_CURL_EXIT:-0}" != "0" ]; then
  exit "$MAESTRO_TEST_CURL_EXIT"
fi
output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      output="$2"
      shift 2
      ;;
    *) shift ;;
  esac
done
[ -n "$output" ] || exit 64
cp "$MAESTRO_TEST_ARCHIVE" "$output"
SH

cat >"$fake_bin/shasum" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
last="${!#}"
printf '%s  %s\n' "$MAESTRO_TEST_SHA256" "$last"
SH

cat >"$fake_bin/java" <<'SH'
#!/usr/bin/env bash
exit 0
SH

cat >"$fake_bin/maestro" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "${MAESTRO_TEST_AMBIENT_VERSION:-cli-0.0.0}"
SH

cat >"$fake_bin/mv" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
count=0
if [ -f "$MAESTRO_TEST_MV_COUNTER" ]; then
  count="$(cat "$MAESTRO_TEST_MV_COUNTER")"
fi
count=$((count + 1))
printf '%s\n' "$count" >"$MAESTRO_TEST_MV_COUNTER"
if [ "${MAESTRO_TEST_MV_FAIL_SECOND:-0}" = "1" ] && [ "$count" = "2" ]; then
  exit 73
fi
exec /bin/mv "$@"
SH

chmod 0755 "$fake_bin"/*

fallback_bin="$test_root/fallback-bin"
no_hash_bin="$test_root/no-hash-bin"
mkdir -p "$fallback_bin" "$no_hash_bin"
for command_name in bash git grep sed tr awk mkdir mktemp python3 chmod rm cp cat; do
  command_path="$(command -v "$command_name")"
  ln -s "$command_path" "$fallback_bin/$command_name"
  ln -s "$command_path" "$no_hash_bin/$command_name"
done
for helper in curl java maestro mv; do
  cp "$fake_bin/$helper" "$fallback_bin/$helper"
  cp "$fake_bin/$helper" "$no_hash_bin/$helper"
done
cp "$fake_bin/shasum" "$fallback_bin/sha256sum"

make_archive() {
  local output="$1"
  local launcher_version="$2"
  local shape="$3"
  python3 - "$output" "$launcher_version" "$shape" "$expected_version" <<'PY'
import stat
import sys
import zipfile
from pathlib import Path

output = Path(sys.argv[1])
version = sys.argv[2]
shape = sys.argv[3]
archive_version = sys.argv[4]

def entry(name, contents, mode):
    info = zipfile.ZipInfo(name)
    info.external_attr = mode << 16
    archive.writestr(info, contents)

with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    entry("maestro/", b"", stat.S_IFDIR | 0o755)
    entry("maestro/bin/", b"", stat.S_IFDIR | 0o755)
    entry(
        "maestro/bin/maestro",
        f"#!/usr/bin/env bash\nprintf '{version}\\n'\n".encode(),
        stat.S_IFREG | 0o755,
    )
    entry("maestro/lib/", b"", stat.S_IFDIR | 0o755)
    if shape != "missing-jar":
        entry(
            f"maestro/lib/maestro-cli-{archive_version}.jar",
            b"mock jar",
            stat.S_IFREG | 0o644,
        )
    if shape == "traversal":
        entry("maestro/../escape", b"escape", stat.S_IFREG | 0o644)
PY
}

valid_archive="$test_root/valid.zip"
wrong_version_archive="$test_root/wrong-version.zip"
missing_jar_archive="$test_root/missing-jar.zip"
traversal_archive="$test_root/traversal.zip"
corrupt_archive="$test_root/corrupt.zip"
make_archive "$valid_archive" "$expected_version" valid
make_archive "$wrong_version_archive" "999.999.999" valid
make_archive "$missing_jar_archive" "$expected_version" missing-jar
make_archive "$traversal_archive" "$expected_version" traversal
printf 'not a zip archive\n' >"$corrupt_archive"

run_case() {
  local name="$1"
  local configured_version="$2"
  local archive="$3"
  local reported_sha256="$4"
  local fail_second_mv="${5:-0}"
  local curl_exit="${6:-0}"
  local manifest_mode="${7:-pinned}"
  local hash_mode="${8:-shasum}"
  local ambient_version="${9:-cli-0.0.0}"
  local case_path
  case "$hash_mode" in
    shasum) case_path="$fake_bin:$PATH" ;;
    sha256sum) case_path="$fallback_bin" ;;
    none) case_path="$no_hash_bin" ;;
    *) fail "unknown hash mode: $hash_mode" ;;
  esac

  CASE_ROOT="$test_root/cases/$name"
  CASE_REPO="$CASE_ROOT/repo"
  CASE_HOME="$CASE_ROOT/home"
  CASE_LOG="$CASE_ROOT/setup.log"
  CASE_CURL_ARGS="$CASE_ROOT/curl-args"
  CASE_GITHUB_PATH="$CASE_ROOT/github-path"
  mkdir -p "$CASE_REPO/tools/dev" "$CASE_REPO/src/sources/toolchains" "$CASE_HOME/.maestro"
  cp "$installer" "$CASE_REPO/tools/dev/setup-maestro.sh"
  case "$manifest_mode" in
    pinned)
      printf '[toolchain]\nmaestro = "%s"\ninstall_url = "%s"\nsha256 = "%s"\n' \
        "$configured_version" "$expected_url" "$expected_sha256" \
        >"$CASE_REPO/src/sources/toolchains/maestro.toml"
      ;;
    unpinned)
      printf '[toolchain]\nmaestro = "%s"\n' \
        "$configured_version" >"$CASE_REPO/src/sources/toolchains/maestro.toml"
      ;;
    wrong-url)
      printf '[toolchain]\nmaestro = "%s"\ninstall_url = "https://example.invalid/maestro.zip"\nsha256 = "%s"\n' \
        "$configured_version" "$expected_sha256" \
        >"$CASE_REPO/src/sources/toolchains/maestro.toml"
      ;;
    invalid-sha)
      printf '[toolchain]\nmaestro = "%s"\ninstall_url = "%s"\nsha256 = "not-a-sha256"\n' \
        "$configured_version" "$expected_url" \
        >"$CASE_REPO/src/sources/toolchains/maestro.toml"
      ;;
    *) fail "unknown manifest mode: $manifest_mode" ;;
  esac
  printf 'previous installation\n' >"$CASE_HOME/.maestro/previous-marker"
  git -C "$CASE_REPO" init -q

  if (
    cd "$CASE_REPO"
    env \
      PATH="$case_path" \
      HOME="$CASE_HOME" \
      GITHUB_PATH="$CASE_GITHUB_PATH" \
      MAESTRO_TEST_ARCHIVE="$archive" \
      MAESTRO_TEST_CURL_ARGS="$CASE_CURL_ARGS" \
      MAESTRO_TEST_CURL_EXIT="$curl_exit" \
      MAESTRO_TEST_SHA256="$reported_sha256" \
      MAESTRO_TEST_MV_COUNTER="$CASE_ROOT/mv-count" \
      MAESTRO_TEST_MV_FAIL_SECOND="$fail_second_mv" \
      MAESTRO_TEST_AMBIENT_VERSION="$ambient_version" \
      bash "$CASE_REPO/tools/dev/setup-maestro.sh"
  ) >"$CASE_LOG" 2>&1; then
    CASE_STATUS=0
  else
    CASE_STATUS=$?
  fi
}

assert_previous_preserved() {
  [ -f "$CASE_HOME/.maestro/previous-marker" ] || fail "$CASE_ROOT did not preserve the previous installation"
}

assert_no_staging_dirs() {
  local leftover
  leftover="$(find "$CASE_HOME" -maxdepth 1 -name '.maestro.install.*' -print -quit)"
  [ -z "$leftover" ] || fail "$CASE_ROOT left installation staging behind: $leftover"
}

run_case success "$configured_version" "$valid_archive" "$expected_sha256"
[ "$CASE_STATUS" = "0" ] || fail "valid pinned archive failed: $(cat "$CASE_LOG")"
[ -x "$CASE_HOME/.maestro/bin/maestro" ] || fail "valid install did not promote the launcher"
[ -f "$CASE_HOME/.maestro/lib/maestro-cli-$expected_version.jar" ] || fail "valid install did not promote the pinned jar"
[ ! -e "$CASE_HOME/.maestro/previous-marker" ] || fail "valid install retained stale installation contents"
[ "$("$CASE_HOME/.maestro/bin/maestro" --version)" = "$expected_version" ] || fail "promoted launcher has the wrong version"
[ "$(cat "$CASE_GITHUB_PATH")" = "$CASE_HOME/.maestro/bin" ] || fail "valid install wrote the wrong GitHub PATH entry"
assert_no_staging_dirs
for argument in \
  --fail \
  --location \
  --retry-all-errors \
  --retry-max-time \
  --connect-timeout \
  --max-time \
  --max-filesize \
  --proto \
  --proto-redir \
  --tlsv1.2 \
  --remove-on-error \
  '=https' \
  "$expected_url"; do
  assert_curl_arg "$CASE_CURL_ARGS" "$argument"
done

run_case prefixed-version "cli-$expected_version" "$valid_archive" "$expected_sha256"
[ "$CASE_STATUS" = "0" ] || fail "cli-prefixed configured version was not preserved"

run_case same-version-ambient "$expected_version" "$valid_archive" "$expected_sha256" 0 0 pinned shasum "cli-$expected_version"
[ "$CASE_STATUS" = "0" ] || fail "a same-version ambient Maestro prevented the pinned installation"
[ -s "$CASE_CURL_ARGS" ] || fail "a same-version ambient Maestro bypassed the pinned archive download"
[ -x "$CASE_HOME/.maestro/bin/maestro" ] || fail "same-version ambient repair did not promote the pinned launcher"
assert_no_staging_dirs

run_case sha256sum-fallback "$expected_version" "$valid_archive" "$expected_sha256" 0 0 pinned sha256sum
[ "$CASE_STATUS" = "0" ] || fail "sha256sum-only environment failed: $(cat "$CASE_LOG")"

run_case missing-hash-command "$expected_version" "$valid_archive" "$expected_sha256" 0 0 pinned none
[ "$CASE_STATUS" = "127" ] || fail "missing hash utilities did not fail with status 127"
assert_contains "$CASE_LOG" "requires shasum or sha256sum"
[ ! -e "$CASE_CURL_ARGS" ] || fail "missing hash utilities reached the network"
assert_previous_preserved
assert_no_staging_dirs

run_case checksum-mismatch "$expected_version" "$valid_archive" "0000000000000000000000000000000000000000000000000000000000000000"
[ "$CASE_STATUS" != "0" ] || fail "checksum mismatch unexpectedly succeeded"
assert_contains "$CASE_LOG" "archive checksum mismatch"
assert_previous_preserved
assert_no_staging_dirs

run_case corrupt-archive "$expected_version" "$corrupt_archive" "$expected_sha256"
[ "$CASE_STATUS" != "0" ] || fail "corrupt archive unexpectedly succeeded"
assert_contains "$CASE_LOG" "invalid Maestro archive"
assert_previous_preserved
assert_no_staging_dirs

run_case missing-layout "$expected_version" "$missing_jar_archive" "$expected_sha256"
[ "$CASE_STATUS" != "0" ] || fail "archive with a missing CLI jar unexpectedly succeeded"
assert_contains "$CASE_LOG" "missing expected archive entries"
assert_previous_preserved
assert_no_staging_dirs

run_case wrong-version "$expected_version" "$wrong_version_archive" "$expected_sha256"
[ "$CASE_STATUS" != "0" ] || fail "archive with the wrong launcher version unexpectedly succeeded"
assert_contains "$CASE_LOG" "launcher version mismatch"
assert_previous_preserved
assert_no_staging_dirs

run_case traversal "$expected_version" "$traversal_archive" "$expected_sha256"
[ "$CASE_STATUS" != "0" ] || fail "archive with path traversal unexpectedly succeeded"
assert_contains "$CASE_LOG" "unsafe archive path"
assert_previous_preserved
assert_no_staging_dirs

run_case unpinned-version 999.999.998 "$valid_archive" "$expected_sha256" 0 0 unpinned
[ "$CASE_STATUS" != "0" ] || fail "unpinned manifest unexpectedly succeeded"
assert_contains "$CASE_LOG" "must contain exactly one quoted maestro version, install_url, and sha256 pin"
[ ! -e "$CASE_CURL_ARGS" ] || fail "unpinned configured version reached the network"
assert_previous_preserved
assert_no_staging_dirs

run_case wrong-release-url "$expected_version" "$valid_archive" "$expected_sha256" 0 0 wrong-url
[ "$CASE_STATUS" != "0" ] || fail "manifest with a non-release URL unexpectedly succeeded"
assert_contains "$CASE_LOG" "install_url must be the exact release asset for cli-$expected_version"
[ ! -e "$CASE_CURL_ARGS" ] || fail "invalid release URL reached the network"
assert_previous_preserved
assert_no_staging_dirs

run_case invalid-sha "$expected_version" "$valid_archive" "$expected_sha256" 0 0 invalid-sha
[ "$CASE_STATUS" != "0" ] || fail "manifest with an invalid checksum unexpectedly succeeded"
assert_contains "$CASE_LOG" "sha256 must be exactly 64 hexadecimal characters"
[ ! -e "$CASE_CURL_ARGS" ] || fail "invalid checksum metadata reached the network"
assert_previous_preserved
assert_no_staging_dirs

run_case promotion-rollback "$expected_version" "$valid_archive" "$expected_sha256" 1
[ "$CASE_STATUS" != "0" ] || fail "failed atomic promotion unexpectedly succeeded"
assert_contains "$CASE_LOG" "previous installation was restored"
assert_previous_preserved
assert_no_staging_dirs

run_case transport-failure "$expected_version" "$valid_archive" "$expected_sha256" 0 22
[ "$CASE_STATUS" != "0" ] || fail "transport failure unexpectedly succeeded"
assert_previous_preserved
assert_no_staging_dirs

echo "setup-maestro installer tests passed"

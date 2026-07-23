#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
installer="$repo_root/.github/actions/setup-wasmer-llvm/install.sh"
curl_platform_flags="$repo_root/tools/dev/curl-platform-flags.sh"

fail() {
  echo "install.test.sh: $*" >&2
  exit 1
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

work_root="$(mktemp -d)"
cleanup() {
  rm -rf "$work_root"
}
trap cleanup EXIT HUP INT TERM

make_archive() {
  local archive="$1"
  local version="$2"
  local targets="$3"
  local tree
  tree="$work_root/archive-tree-$(basename "$archive")"
  mkdir -p "$tree/bin"
  # shellcheck disable=SC2016 # These literals are emitted into the fixture script.
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    'if [[ "${OLIPHAUNT_WASMER_LLVM_TEST_REQUIRE_FINAL_ABSENT:-}" == 1 && -e "${OLIPHAUNT_WASMER_LLVM_TEST_FINAL:?}" ]]; then' \
    '  echo "final install existed before staged validation" >&2' \
    '  exit 93' \
    'fi' \
    'case "${1:-}" in' \
    "  --version) printf '%s\\n' '$version' ;;" \
    "  --targets-built) printf '%s\\n' '$targets' ;;" \
    '  *) exit 64 ;;' \
    'esac' > "$tree/bin/llvm-config"
  chmod 755 "$tree/bin/llvm-config"
  ln -s llvm-config "$tree/bin/llvm-config-link"
  ln -s llvm-config-link "$tree/bin/llvm-config-link-chain"
  tar -cJf "$archive" -C "$tree" .
}

assert_no_partial_install() {
  local runner_temp="$1"
  local cache_key="$2"
  [ ! -e "$runner_temp/wasmer-llvm/$cache_key/llvm" ] || fail "failed installation left a final llvm directory"
  local leftover
  leftover="$(find "$runner_temp" \( -name '.llvm-stage.*' -o -name 'wasmer-llvm-*.archive.*' \) -print -quit)"
  [ -z "$leftover" ] || fail "failed installation left temporary state: $leftover"
}

assert_archive_rejected() {
  local label="$1"
  local archive="$2"
  local sha runner cache_key
  sha="$(sha256_file "$archive")"
  runner="$work_root/$label-runner"
  cache_key="wasmer-llvm-Linux-X64-22.1-$label"
  if run_installer "$runner" "$cache_key" "$archive" "$sha" \
    "$work_root/$label-curl.log" >/dev/null 2>&1; then
    fail "$label archive unexpectedly succeeded"
  fi
  assert_no_partial_install "$runner" "$cache_key"
}

run_installer() {
  local runner_temp="$1"
  local cache_key="$2"
  local archive="$3"
  local expected_sha="$4"
  local log="$5"
  local expected_bytes="${6:-}"
  if [ -z "$expected_bytes" ]; then
    expected_bytes="$(wc -c < "$archive" | tr -d '[:space:]')"
  fi
  mkdir -p "$runner_temp"
  : > "$runner_temp/github-env"
  : > "$runner_temp/github-path"
  OLIPHAUNT_WASMER_LLVM_TEST_ARCHIVE="$archive" \
  OLIPHAUNT_WASMER_LLVM_TEST_LOG="$log" \
  OLIPHAUNT_WASMER_LLVM_TEST_MODE="${OLIPHAUNT_WASMER_LLVM_TEST_MODE:-copy}" \
  LLVM_URL=https://downloads.invalid/llvm.tar.xz \
  LLVM_SHA256="$expected_sha" \
  LLVM_BYTES="$expected_bytes" \
  LLVM_VERSION=22.1 \
  ACTION_PATH="$repo_root/.github/actions/setup-wasmer-llvm" \
  CACHE_KEY="$cache_key" \
  RUNNER_TEMP="$runner_temp" \
  RUNNER_OS=Linux \
  GITHUB_ENV="$runner_temp/github-env" \
  GITHUB_PATH="$runner_temp/github-path" \
  PATH="$script_dir/testdata/setup-wasmer-llvm:$PATH" \
    bash "$installer"
}

valid_archive="$work_root/valid.tar.xz"
make_archive "$valid_archive" 22.1.0 'X86 LoongArch WebAssembly'
valid_sha="$(sha256_file "$valid_archive")"
valid_bytes="$(wc -c < "$valid_archive" | tr -d '[:space:]')"

# Wasmer LLVM shares the bootstrap-safe shell policy with downloaders that may
# run before Bun is available. Prove both sides of the platform branch and that
# the installer actually consumes it.
# shellcheck source=tools/dev/curl-platform-flags.sh
. "$curl_platform_flags"
[ "$(RUNNER_OS=Windows oliphaunt_curl_platform_tls_flag)" = '--ssl-revoke-best-effort' ] ||
  fail "Windows curl policy omitted Schannel revocation-offline handling"
[ -z "$(RUNNER_OS=Linux oliphaunt_curl_platform_tls_flag)" ] ||
  fail "Linux curl policy unexpectedly emitted a platform TLS flag"
[ -z "$(RUNNER_OS=macOS oliphaunt_curl_platform_tls_flag)" ] ||
  fail "macOS curl policy unexpectedly emitted a platform TLS flag"
uname() { printf '%s\n' 'MINGW64_NT-10.0'; }
[ "$(RUNNER_OS= oliphaunt_curl_platform_tls_flag)" = '--ssl-revoke-best-effort' ] ||
  fail "Git Bash uname fallback omitted Schannel revocation-offline handling"
unset -f uname
grep -F 'oliphaunt_curl_platform_tls_flag' "$installer" >/dev/null ||
  fail "Wasmer LLVM installer does not apply the shared curl platform policy"
if grep -E -- '--insecure|(^|[^[:alnum:]])-k([^[:alnum:]]|$)' "$installer" >/dev/null; then
  fail "Wasmer LLVM installer disables TLS validation"
fi

transport_runner="$work_root/transport-runner"
transport_key=wasmer-llvm-Linux-X64-22.1-transport
if OLIPHAUNT_WASMER_LLVM_TEST_MODE=transport-fail \
  run_installer "$transport_runner" "$transport_key" "$valid_archive" "$valid_sha" \
    "$work_root/transport-curl.log" >/dev/null 2>&1; then
  fail "failed archive transport unexpectedly succeeded"
fi
assert_no_partial_install "$transport_runner" "$transport_key"

bad_sha_runner="$work_root/bad-sha-runner"
bad_sha_key=wasmer-llvm-Linux-X64-22.1-bad-sha
if run_installer "$bad_sha_runner" "$bad_sha_key" "$valid_archive" \
  0000000000000000000000000000000000000000000000000000000000000000 \
  "$work_root/bad-sha-curl.log" >/dev/null 2>&1; then
  fail "incorrect archive SHA-256 unexpectedly succeeded"
fi
assert_no_partial_install "$bad_sha_runner" "$bad_sha_key"

bad_size_runner="$work_root/bad-size-runner"
bad_size_key=wasmer-llvm-Linux-X64-22.1-bad-size
if run_installer "$bad_size_runner" "$bad_size_key" "$valid_archive" "$valid_sha" \
  "$work_root/bad-size-curl.log" "$((valid_bytes + 1))" >/dev/null 2>&1; then
  fail "incorrect archive byte size unexpectedly succeeded"
fi
assert_no_partial_install "$bad_size_runner" "$bad_size_key"

unsafe_archive="$work_root/unsafe.tar.xz"
python3 - "$unsafe_archive" <<'PY'
import io
import sys
import tarfile

with tarfile.open(sys.argv[1], "w:xz") as archive:
    info = tarfile.TarInfo("../escaped")
    payload = b"unsafe"
    info.size = len(payload)
    archive.addfile(info, io.BytesIO(payload))
PY
unsafe_sha="$(sha256_file "$unsafe_archive")"
unsafe_runner="$work_root/unsafe-runner"
unsafe_key=wasmer-llvm-Linux-X64-22.1-unsafe
if run_installer "$unsafe_runner" "$unsafe_key" "$unsafe_archive" "$unsafe_sha" \
  "$work_root/unsafe-curl.log" >/dev/null 2>&1; then
  fail "traversal archive unexpectedly succeeded"
fi
assert_no_partial_install "$unsafe_runner" "$unsafe_key"
[ ! -e "$unsafe_runner/wasmer-llvm/$unsafe_key/escaped" ] || fail "traversal archive wrote outside staging"

unsafe_link_archive="$work_root/unsafe-link.tar.xz"
python3 - "$unsafe_link_archive" <<'PY'
import sys
import tarfile

with tarfile.open(sys.argv[1], "w:xz") as archive:
    info = tarfile.TarInfo("bin/escape")
    info.type = tarfile.SYMTYPE
    info.linkname = "../../escaped"
    archive.addfile(info)
PY
assert_archive_rejected unsafe-link "$unsafe_link_archive"

duplicate_archive="$work_root/duplicate.tar.xz"
python3 - "$duplicate_archive" <<'PY'
import io
import sys
import tarfile

with tarfile.open(sys.argv[1], "w:xz") as archive:
    for payload in (b"first", b"second"):
        info = tarfile.TarInfo("bin/duplicate")
        info.size = len(payload)
        archive.addfile(info, io.BytesIO(payload))
PY
assert_archive_rejected duplicate "$duplicate_archive"

special_archive="$work_root/special.tar.xz"
python3 - "$special_archive" <<'PY'
import sys
import tarfile

with tarfile.open(sys.argv[1], "w:xz") as archive:
    info = tarfile.TarInfo("bin/fifo")
    info.type = tarfile.FIFOTYPE
    archive.addfile(info)
PY
assert_archive_rejected special "$special_archive"

oversized_archive="$work_root/oversized.tar.xz"
python3 - "$oversized_archive" <<'PY'
import sys
import tarfile

with tarfile.open(sys.argv[1], "w:xz") as archive:
    info = tarfile.TarInfo("lib/oversized")
    info.size = 4 * 1024 * 1024 * 1024 + 1
    # A header-only member is intentionally malformed as well as oversized. The
    # validator must reject its declared expansion before extraction can run.
    archive.addfile(info)
PY
assert_archive_rejected oversized "$oversized_archive"

truncated_archive="$work_root/truncated.tar.xz"
head -c 64 "$valid_archive" > "$truncated_archive"
truncated_sha="$(sha256_file "$truncated_archive")"
truncated_runner="$work_root/truncated-runner"
truncated_key=wasmer-llvm-Linux-X64-22.1-truncated
if run_installer "$truncated_runner" "$truncated_key" "$truncated_archive" "$truncated_sha" \
  "$work_root/truncated-curl.log" >/dev/null 2>&1; then
  fail "truncated archive unexpectedly succeeded"
fi
assert_no_partial_install "$truncated_runner" "$truncated_key"

wrong_version_archive="$work_root/wrong-version.tar.xz"
make_archive "$wrong_version_archive" 21.1.0 'X86 LoongArch WebAssembly'
wrong_version_sha="$(sha256_file "$wrong_version_archive")"
wrong_version_runner="$work_root/wrong-version-runner"
wrong_version_key=wasmer-llvm-Linux-X64-22.1-wrong-version
if run_installer "$wrong_version_runner" "$wrong_version_key" "$wrong_version_archive" "$wrong_version_sha" \
  "$work_root/wrong-version-curl.log" >/dev/null 2>&1; then
  fail "archive with the wrong LLVM version unexpectedly succeeded"
fi
assert_no_partial_install "$wrong_version_runner" "$wrong_version_key"

wrong_targets_archive="$work_root/wrong-targets.tar.xz"
make_archive "$wrong_targets_archive" 22.1.0 'X86 WebAssembly'
wrong_targets_sha="$(sha256_file "$wrong_targets_archive")"
wrong_targets_runner="$work_root/wrong-targets-runner"
wrong_targets_key=wasmer-llvm-Linux-X64-22.1-wrong-targets
if run_installer "$wrong_targets_runner" "$wrong_targets_key" "$wrong_targets_archive" "$wrong_targets_sha" \
  "$work_root/wrong-targets-curl.log" >/dev/null 2>&1; then
  fail "archive without the required LLVM targets unexpectedly succeeded"
fi
assert_no_partial_install "$wrong_targets_runner" "$wrong_targets_key"

success_runner="$work_root/success-runner"
success_key=wasmer-llvm-Linux-X64-22.1-success
success_final="$success_runner/wasmer-llvm/$success_key/llvm"
success_log="$work_root/success-curl.log"
OLIPHAUNT_WASMER_LLVM_TEST_REQUIRE_FINAL_ABSENT=1 \
OLIPHAUNT_WASMER_LLVM_TEST_FINAL="$success_final" \
  run_installer "$success_runner" "$success_key" "$valid_archive" "$valid_sha" "$success_log"
[ -x "$success_final/bin/llvm-config" ] || fail "verified staged install was not atomically promoted"
identity_file="$success_final/.oliphaunt-wasmer-llvm"
[ -f "$identity_file" ] || fail "promoted install omitted its pinned archive identity"
grep -Fx "sha256=$valid_sha" "$identity_file" >/dev/null || fail "cache identity omitted the archive SHA-256"
grep -Fx "bytes=$valid_bytes" "$identity_file" >/dev/null || fail "cache identity omitted the exact archive size"
grep -F "LLVM_PATH=$success_final" "$success_runner/github-env" >/dev/null || fail "LLVM_PATH omitted promoted install"
grep -F "$success_final/bin" "$success_runner/github-path" >/dev/null || fail "GITHUB_PATH omitted promoted bin directory"
for flag in \
  '--location' \
  '--fail' \
  '--retry 4' \
  '--retry-all-errors' \
  '--retry-delay 10' \
  '--retry-max-time 3600' \
  '--connect-timeout 30' \
  '--max-time 1800' \
  "--max-filesize $valid_bytes" \
  '--proto =https' \
  '--proto-redir =https' \
  '--tlsv1.2'; do
  grep -F -- "$flag" "$success_log" >/dev/null || fail "curl invocation omitted $flag"
done

curl_count="$(wc -l < "$success_log" | tr -d ' ')"
run_installer "$success_runner" "$success_key" "$work_root/does-not-exist" "$valid_sha" "$success_log" "$valid_bytes"
[ "$(wc -l < "$success_log" | tr -d ' ')" = "$curl_count" ] || fail "verified cache identity downloaded LLVM again"

printf '%s\n' 'schema=0' > "$identity_file"
if run_installer "$success_runner" "$success_key" "$work_root/does-not-exist" "$valid_sha" \
  "$success_log" "$valid_bytes" >/dev/null 2>&1; then
  fail "cache with a mismatched archive identity unexpectedly succeeded"
fi
assert_no_partial_install "$success_runner" "$success_key"

echo "Wasmer LLVM atomic installation tests passed"

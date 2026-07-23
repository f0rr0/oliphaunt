#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
installer="$script_dir/install-pinned-wasixcc.sh"
production_manifest="$script_dir/pinned-wasixcc-assets.tsv"
dockerfile="$script_dir/Dockerfile"
expected_production_manifest_sha256="9b0ee1aabcfecda1be72c94a9f14a16c9d8a2fc020f3dc471394d5335766c519"

fail() {
  echo "install-pinned-wasixcc.test: $*" >&2
  exit 1
}

work_root="$(mktemp -d)"
trap 'rm -rf "$work_root"' EXIT
fixtures="$work_root/fixtures"
fake_bin="$work_root/fake-bin"
mkdir -p "$fixtures" "$fake_bin"

cat >"$work_root/fake-wasixccenv" <<'DRIVER'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "--version" ]; then
  echo "wasixcc 0.4.3"
  if [ "${0##*/}" != "wasixccenv" ]; then
    echo "----------------------------------"
    echo "WASIX clang version 21.1.2"
    echo "Target: unknown"
    echo "Thread model: posix"
    echo "InstalledDir: ${WASIXCC_LLVM_LOCATION:?}/bin"
  fi
  exit 0
fi
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    output="${2:?missing output after -o}"
    shift 2
  else
    shift
  fi
done
[ -n "$output" ] || exit 2
printf '\x00\x61\x73\x6d\x01\x00\x00\x00' >"$output"
DRIVER
chmod 0755 "$work_root/fake-wasixccenv"
tar -czf "$fixtures/wasixcc-x86_64-unknown-linux-gnu.tar.gz" \
  -C "$work_root" fake-wasixccenv \
  --transform='s/fake-wasixccenv/wasixccenv/'

for sysroot_name in sysroot sysroot-eh sysroot-ehpic sysroot-exnref-eh sysroot-exnref-ehpic; do
  sysroot_fixture="$work_root/wasix-$sysroot_name/sysroot"
  mkdir -p "$sysroot_fixture/include" "$sysroot_fixture/lib/wasm32-wasi"
  printf '%s\n' '/* fixture */' >"$sysroot_fixture/include/stdio.h"
  : >"$sysroot_fixture/lib/wasm32-wasi/libc.a"
  tar -czf "$fixtures/$sysroot_name.tar.gz" -C "$work_root" "wasix-$sysroot_name"
done

mkdir -p "$work_root/llvm/bin" "$work_root/llvm/lib"
cat >"$work_root/llvm/bin/clang-21" <<'CLANG'
#!/usr/bin/env bash
echo "WASIX clang version 21.1.2"
CLANG
chmod 0755 "$work_root/llvm/bin/clang-21"
ln -s clang-21 "$work_root/llvm/bin/clang"
ln -s clang-21 "$work_root/llvm/bin/clang++"
for executable in llvm-ar llvm-nm wasm-ld; do
  cp "$work_root/llvm/bin/clang-21" "$work_root/llvm/bin/$executable"
done
ln -s llvm-ar "$work_root/llvm/bin/llvm-ranlib"
tar -czf "$fixtures/LLVM-Linux-x86_64.tar.gz" -C "$work_root/llvm" bin lib

mkdir -p "$work_root/binaryen-version_130/bin"
cat >"$work_root/binaryen-version_130/bin/wasm-opt" <<'BINARYEN'
#!/usr/bin/env bash
echo "wasm-opt version 130 (version_130)"
BINARYEN
chmod 0755 "$work_root/binaryen-version_130/bin/wasm-opt"
tar -czf "$fixtures/binaryen-version_130-x86_64-linux.tar.gz" \
  -C "$work_root" binaryen-version_130

cat >"$fake_bin/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
expect_output=0
for argument in "$@"; do
  if [ "$expect_output" = "1" ]; then
    output="$argument"
    expect_output=0
    continue
  fi
  case "$argument" in
    --output) expect_output=1 ;;
    https://*) url="$argument" ;;
  esac
done
[ -n "$output" ] && [ -n "$url" ] || exit 2
asset="${url##*/}"
printf '%s\n' "$*" >>"${OLIPHAUNT_FAKE_CURL_LOG:?}"
if [ "${OLIPHAUNT_FAKE_CURL_FAIL_ASSET:-}" = "$asset" ]; then
  exit 56
fi
cp "${OLIPHAUNT_FIXTURE_ROOT:?}/$asset" "$output"
if [ "${OLIPHAUNT_FAKE_CURL_BLOCK_ASSET:-}" = "$asset" ]; then
  printf '%s\n' "$$" >"${OLIPHAUNT_FAKE_CURL_CHILD_PID:?}"
  : >"${OLIPHAUNT_FAKE_CURL_READY:?}"
  trap 'exit 143' TERM
  while true; do
    sleep 1
  done
fi
case "${OLIPHAUNT_FAKE_CURL_MODE:-success}" in
  success) ;;
  truncate)
    bytes="$(wc -c <"$output")"
    truncate -s "$((bytes - 1))" "$output"
    ;;
  corrupt)
    printf X | dd of="$output" bs=1 seek=0 conv=notrunc status=none
    ;;
  *) exit 2 ;;
esac
CURL
chmod 0755 "$fake_bin/curl"

write_manifest() {
  local fixture_root="$1"
  local destination="$2"
  local kind
  local asset
  local url
  local bytes
  local sha256

  printf '%s\n' '# oliphaunt-wasixcc-toolchain-assets-v1' >"$destination"
  while IFS=$'\t' read -r kind asset url; do
    bytes="$(wc -c <"$fixture_root/$asset" | awk '{print $1}')"
    sha256="$(sha256sum "$fixture_root/$asset" | awk '{print $1}')"
    printf '%s\t%s\t%s\t%s\t%s\n' "$kind" "$asset" "$bytes" "$sha256" "$url" >>"$destination"
  done <<'ROWS'
driver	wasixcc-x86_64-unknown-linux-gnu.tar.gz	https://github.com/wasix-org/wasixcc/releases/download/v0.4.3/wasixcc-x86_64-unknown-linux-gnu.tar.gz
sysroot	sysroot.tar.gz	https://github.com/wasix-org/wasix-libc/releases/download/v2026-03-02.1/sysroot.tar.gz
sysroot	sysroot-eh.tar.gz	https://github.com/wasix-org/wasix-libc/releases/download/v2026-03-02.1/sysroot-eh.tar.gz
sysroot	sysroot-ehpic.tar.gz	https://github.com/wasix-org/wasix-libc/releases/download/v2026-03-02.1/sysroot-ehpic.tar.gz
sysroot	sysroot-exnref-eh.tar.gz	https://github.com/wasix-org/wasix-libc/releases/download/v2026-03-02.1/sysroot-exnref-eh.tar.gz
sysroot	sysroot-exnref-ehpic.tar.gz	https://github.com/wasix-org/wasix-libc/releases/download/v2026-03-02.1/sysroot-exnref-ehpic.tar.gz
llvm	LLVM-Linux-x86_64.tar.gz	https://github.com/wasix-org/llvm-project/releases/download/21.1.204/LLVM-Linux-x86_64.tar.gz
binaryen	binaryen-version_130-x86_64-linux.tar.gz	https://github.com/WebAssembly/binaryen/releases/download/version_130/binaryen-version_130-x86_64-linux.tar.gz
ROWS
}

run_installer() {
  local fixture_root="$1"
  local manifest="$2"
  local destination="$3"
  local mode="${4:-success}"
  local fail_asset="${5:-}"
  local log="$work_root/curl.log"

  : >"$log"
  PATH="$fake_bin:$PATH" \
    OLIPHAUNT_FIXTURE_ROOT="$fixture_root" \
    OLIPHAUNT_FAKE_CURL_LOG="$log" \
    OLIPHAUNT_FAKE_CURL_MODE="$mode" \
    OLIPHAUNT_FAKE_CURL_FAIL_ASSET="$fail_asset" \
    OLIPHAUNT_FAKE_CURL_BLOCK_ASSET="" \
    "$installer" --manifest "$manifest" --install-root "$destination"
}

expect_failure() {
  local label="$1"
  local expected_message="$2"
  shift 2
  local output
  local status

  set +e
  output="$("$@" 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail "$label unexpectedly succeeded"
  printf '%s\n' "$output" | grep -F -- "$expected_message" >/dev/null ||
    fail "$label did not report '$expected_message': $output"
}

assert_no_partial_install() {
  local destination="$1"
  local label="$2"
  local parent

  if [ -e "$destination" ] || [ -L "$destination" ]; then
    fail "$label made an incomplete final install visible"
  fi
  parent="$(dirname "$destination")"
  if [ -d "$parent" ] && find "$parent" -maxdepth 1 -name '.wasixcc-install.*' -print | grep -q .; then
    fail "$label left an installation staging directory"
  fi
}

malicious_driver_archive() {
  local kind="$1"
  local destination="$2"
  python3 - "$kind" "$destination" "$work_root/fake-wasixccenv" <<'PY'
import io
import sys
import tarfile
from pathlib import Path

kind = sys.argv[1]
destination = sys.argv[2]
driver = Path(sys.argv[3]).read_bytes()


def regular(archive, name, data=b"fixture"):
    member = tarfile.TarInfo(name)
    member.mode = 0o755 if name == "wasixccenv" else 0o644
    member.size = len(data)
    archive.addfile(member, io.BytesIO(data))


with tarfile.open(destination, "w:gz") as archive:
    regular(archive, "wasixccenv", driver)
    if kind == "traversal":
        regular(archive, "../escaped")
    elif kind == "duplicate":
        regular(archive, "wasixccenv", driver)
    elif kind == "symlink":
        member = tarfile.TarInfo("escape-symlink")
        member.type = tarfile.SYMTYPE
        member.linkname = "/etc/passwd"
        archive.addfile(member)
    elif kind == "hardlink":
        member = tarfile.TarInfo("escape-hardlink")
        member.type = tarfile.LNKTYPE
        member.linkname = "../outside"
        archive.addfile(member)
    elif kind == "device":
        member = tarfile.TarInfo("device")
        member.type = tarfile.CHRTYPE
        member.devmajor = 1
        member.devminor = 3
        archive.addfile(member)
    else:
        raise SystemExit(f"unknown malicious archive kind: {kind}")
PY
}

run_malicious_archive_case() {
  local kind="$1"
  local expected_message="$2"
  local case_root="$work_root/archive-$kind"
  local case_fixtures="$case_root/fixtures"
  local case_manifest="$case_root/assets.tsv"
  local destination="$case_root/install/.wasixcc"

  mkdir -p "$case_root"
  cp -a "$fixtures" "$case_fixtures"
  malicious_driver_archive "$kind" "$case_fixtures/wasixcc-x86_64-unknown-linux-gnu.tar.gz"
  write_manifest "$case_fixtures" "$case_manifest"
  expect_failure "$kind archive" "$expected_message" \
    run_installer "$case_fixtures" "$case_manifest" "$destination"
  assert_no_partial_install "$destination" "$kind archive"
  [ ! -e "$case_root/escaped" ] || fail "$kind archive wrote outside its extraction root"
}

actual_production_manifest_sha256="$(sha256sum "$production_manifest" | awk '{print $1}')"
[ "$actual_production_manifest_sha256" = "$expected_production_manifest_sha256" ] ||
  fail "production manifest identity changed without updating its Docker/source metadata pin"
if grep -Fq 'raw.githubusercontent.com/wasix-org/wasixcc' "$dockerfile"; then
  fail "Dockerfile still uses the upstream remote installer"
fi
if grep -Eq '(^|[^A-Za-z])latest([^A-Za-z]|$)' "$dockerfile" "$production_manifest"; then
  fail "Docker toolchain inputs must not use latest resolution"
fi
for required_flag in \
  '--retry-all-errors' \
  '--retry-max-time' \
  '--connect-timeout' \
  '--max-time' \
  '--max-filesize' \
  '--proto' \
  '--proto-redir' \
  '--remove-on-error'; do
  grep -F -- "$required_flag" "$installer" >/dev/null || fail "installer is missing curl flag $required_flag"
done

fixture_manifest="$work_root/fixture-assets.tsv"
write_manifest "$fixtures" "$fixture_manifest"
success_root="$work_root/success/.wasixcc"
run_installer "$fixtures" "$fixture_manifest" "$success_root"
success_compiler_version="$(
  WASIXCC_LLVM_LOCATION="$success_root/llvm" "$success_root/bin/wasixcc" --version
)"
expected_success_compiler_version="$(printf '%s\n' \
  'wasixcc 0.4.3' \
  '----------------------------------' \
  'WASIX clang version 21.1.2' \
  'Target: unknown' \
  'Thread model: posix' \
  "InstalledDir: $success_root/llvm/bin")"
[ "$success_compiler_version" = "$expected_success_compiler_version" ] ||
  fail "installed compiler version output is wrong"
[ "$("$success_root/wasixccenv" --version)" = "wasixcc 0.4.3" ] || fail "installed driver version is wrong"
[ "$("$success_root/llvm/bin/clang" --version)" = "WASIX clang version 21.1.2" ] ||
  fail "installed LLVM version is wrong"
[ "$("$success_root/binaryen/bin/wasm-opt" --version)" = "wasm-opt version 130 (version_130)" ] ||
  fail "installed Binaryen version is wrong"
(cd "$success_root" && sha256sum --check --strict .oliphaunt-toolchain-assets.sha256 >/dev/null) ||
  fail "installed identity manifest does not verify"
for required_flag in \
  '--retry 8' \
  '--retry-all-errors' \
  '--connect-timeout 20' \
  '--max-time 900' \
  '--proto =https' \
  '--proto-redir =https' \
  '--remove-on-error'; do
  grep -F -- "$required_flag" "$work_root/curl.log" >/dev/null ||
    fail "curl invocation omitted $required_flag"
done

truncated_root="$work_root/truncated/.wasixcc"
expect_failure "truncated download" "size mismatch" \
  run_installer "$fixtures" "$fixture_manifest" "$truncated_root" truncate
assert_no_partial_install "$truncated_root" "truncated download"

corrupt_root="$work_root/corrupt/.wasixcc"
expect_failure "checksum mismatch" "checksum mismatch" \
  run_installer "$fixtures" "$fixture_manifest" "$corrupt_root" corrupt
assert_no_partial_install "$corrupt_root" "checksum mismatch"

interrupted_root="$work_root/interrupted/.wasixcc"
expect_failure "mid-set transport failure" "" \
  run_installer "$fixtures" "$fixture_manifest" "$interrupted_root" success LLVM-Linux-x86_64.tar.gz
assert_no_partial_install "$interrupted_root" "mid-set transport failure"

invalid_fixtures="$work_root/invalid-fixtures"
cp -a "$fixtures" "$invalid_fixtures"
printf '%s\n' 'not a gzip tar archive' >"$invalid_fixtures/wasixcc-x86_64-unknown-linux-gnu.tar.gz"
invalid_manifest="$work_root/invalid-assets.tsv"
write_manifest "$invalid_fixtures" "$invalid_manifest"
invalid_root="$work_root/invalid/.wasixcc"
expect_failure "invalid archive after matching checksum" "failed archive safety validation" \
  run_installer "$invalid_fixtures" "$invalid_manifest" "$invalid_root"
assert_no_partial_install "$invalid_root" "invalid archive"

run_malicious_archive_case traversal "archive member is unsafe"
run_malicious_archive_case duplicate "duplicate archive member"
run_malicious_archive_case symlink "link target for escape-symlink is absolute"
run_malicious_archive_case hardlink "link target for escape-hardlink is unsafe"
run_malicious_archive_case device "unsupported archive member type"

version_fixtures="$work_root/version-fixtures"
cp -a "$fixtures" "$version_fixtures"
sed 's/wasixcc 0\.4\.3/wasixcc 0.4.2/' "$work_root/fake-wasixccenv" >"$work_root/wrong-version-wasixccenv"
chmod 0755 "$work_root/wrong-version-wasixccenv"
tar -czf "$version_fixtures/wasixcc-x86_64-unknown-linux-gnu.tar.gz" \
  -C "$work_root" wrong-version-wasixccenv \
  --transform='s/wrong-version-wasixccenv/wasixccenv/'
version_manifest="$work_root/version-assets.tsv"
write_manifest "$version_fixtures" "$version_manifest"
version_root="$work_root/version/.wasixcc"
expect_failure "driver version mismatch" "wasixcc driver version mismatch" \
  run_installer "$version_fixtures" "$version_manifest" "$version_root"
assert_no_partial_install "$version_root" "driver version mismatch"

layout_fixtures="$work_root/layout-fixtures"
cp -a "$fixtures" "$layout_fixtures"
rm -rf "$work_root/wasix-sysroot-eh/sysroot/include"
tar -czf "$layout_fixtures/sysroot-eh.tar.gz" -C "$work_root" wasix-sysroot-eh
layout_manifest="$work_root/layout-assets.tsv"
write_manifest "$layout_fixtures" "$layout_manifest"
layout_root="$work_root/layout/.wasixcc"
expect_failure "sysroot layout mismatch" "missing its include directory" \
  run_installer "$layout_fixtures" "$layout_manifest" "$layout_root"
assert_no_partial_install "$layout_root" "sysroot layout mismatch"

signal_root="$work_root/signal/.wasixcc"
signal_log="$work_root/signal.log"
signal_ready="$work_root/signal.ready"
signal_child_pid="$work_root/signal-child.pid"
: >"$work_root/signal-curl.log"
PATH="$fake_bin:$PATH" \
  OLIPHAUNT_FIXTURE_ROOT="$fixtures" \
  OLIPHAUNT_FAKE_CURL_LOG="$work_root/signal-curl.log" \
  OLIPHAUNT_FAKE_CURL_MODE=success \
  OLIPHAUNT_FAKE_CURL_FAIL_ASSET="" \
  OLIPHAUNT_FAKE_CURL_BLOCK_ASSET=wasixcc-x86_64-unknown-linux-gnu.tar.gz \
  OLIPHAUNT_FAKE_CURL_READY="$signal_ready" \
  OLIPHAUNT_FAKE_CURL_CHILD_PID="$signal_child_pid" \
  "$installer" --manifest "$fixture_manifest" --install-root "$signal_root" >"$signal_log" 2>&1 &
signal_installer_pid=$!
for _ in $(seq 1 100); do
  [ -f "$signal_ready" ] && break
  sleep 0.05
done
[ -f "$signal_ready" ] || fail "signal test did not reach an in-progress asset download"
kill -TERM "$signal_installer_pid"
kill -TERM "$(cat "$signal_child_pid")" 2>/dev/null || true
set +e
wait "$signal_installer_pid"
signal_status=$?
set -e
[ "$signal_status" -eq 143 ] || fail "signal interruption exited with $signal_status instead of 143"
assert_no_partial_install "$signal_root" "signal interruption"

existing_root="$work_root/existing/.wasixcc"
mkdir -p "$existing_root"
printf '%s\n' preserved >"$existing_root/marker"
expect_failure "existing install" "refusing a non-atomic replacement" \
  run_installer "$fixtures" "$fixture_manifest" "$existing_root"
[ "$(cat "$existing_root/marker")" = preserved ] || fail "existing installation was modified"

echo "pinned WASIX toolchain installer tests passed"

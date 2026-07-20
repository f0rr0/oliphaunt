#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
installer="$root/src/runtimes/node-direct/tools/install-node-fallback.sh"
extractor="$root/src/runtimes/node-direct/tools/extract-node-headers.mjs"
production_manifest="$root/src/sources/toolchains/node.toml"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-node-fallback-test.XXXXXX")"
trap 'rm -rf "$test_root"' EXIT

fail() {
  echo "install-node-fallback.test.sh: $*" >&2
  exit 1
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

assert_contains() {
  local path="$1"
  local expected="$2"
  grep -F -- "$expected" "$path" >/dev/null || fail "$path did not contain: $expected"
}

assert_curl_arg() {
  local expected="$1"
  grep -Fx -- "$expected" "$CASE_CURL_LOG" >/dev/null || fail "curl did not receive argument: $expected"
}

assert_no_install_debris() {
  local leftover
  leftover="$(find "$CASE_CACHE" -type d \( -name '*.stage.*' -o -name '*.backup.*' \) -print -quit)"
  [ -z "$leftover" ] || fail "$CASE_NAME left staging/backup directory behind: $leftover"
  leftover="$(find "$CASE_CACHE" -type f -name '*.partial.*' -print -quit)"
  [ -z "$leftover" ] || fail "$CASE_NAME left partial download behind: $leftover"
}

fixtures="$test_root/fixtures"
mkdir -p "$fixtures"
node - "$fixtures" <<'JS'
const {writeFileSync} = require('node:fs');
const path = require('node:path');
const {gzipSync} = require('node:zlib');

const output = process.argv[2];
const blockSize = 512;
const root = 'node-v22.22.3';

function writeString(block, offset, length, value) {
  const bytes = Buffer.from(value, 'ascii');
  if (bytes.length > length) throw new Error(`field is too long: ${value}`);
  bytes.copy(block, offset);
}

function writeOctal(block, offset, length, value) {
  const encoded = `${value.toString(8).padStart(length - 1, '0')}\0`;
  writeString(block, offset, length, encoded);
}

function header(name, size, type = '0', linkName = '') {
  const block = Buffer.alloc(blockSize);
  writeString(block, 0, 100, name);
  writeOctal(block, 100, 8, type === '5' ? 0o755 : 0o644);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, 0);
  block.fill(0x20, 148, 156);
  block[156] = type.charCodeAt(0);
  writeString(block, 157, 100, linkName);
  writeString(block, 257, 6, 'ustar');
  writeString(block, 263, 2, '00');
  let checksum = 0;
  for (const byte of block) checksum += byte;
  writeString(block, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return block;
}

function entry(name, contents = '', type = '0', options = {}) {
  const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  const declaredSize = options.declaredSize ?? data.length;
  const blocks = [header(name, declaredSize, type, options.linkName ?? '')];
  if (!options.omitPayload && data.length > 0) {
    blocks.push(data, Buffer.alloc((blockSize - (data.length % blockSize)) % blockSize));
  }
  return blocks;
}

function archive(name, entries) {
  writeFileSync(path.join(output, name), gzipSync(Buffer.concat([...entries.flat(), Buffer.alloc(blockSize * 2)])));
}

const required = [
  ...entry(`${root}/`, '', '5'),
  ...entry(`${root}/include/`, '', '5'),
  ...entry(`${root}/include/node/`, '', '5'),
  ...entry(`${root}/include/node/node_api.h`, 'node api\n'),
  ...entry(`${root}/include/node/node.h`, 'node\n'),
  ...entry(`${root}/include/node/v8.h`, 'v8\n'),
];
const longName = `${root}/include/node/openssl/archs/solaris64-x86_64-gcc/asm_avx2/providers/common/include/prov/der_digests.h`;
const longNameRecord = entry('././@LongLink', Buffer.from(`${longName}\0`), 'L');
const longNameFile = entry(longName.slice(0, 100), 'long name\n');
archive('valid.tar.gz', [...required, ...longNameRecord, ...longNameFile]);
archive('duplicate.tar.gz', [...required, ...entry(`${root}/include/node/node.h`, 'duplicate\n')]);
archive('traversal.tar.gz', [...required, ...entry(`${root}/../../escaped`, 'escape\n')]);
archive('symlink.tar.gz', [...required, ...entry(`${root}/include/node/link`, '', '2', {linkName: '../../escape'})]);
archive('oversized.tar.gz', [
  ...required,
  ...entry(`${root}/include/node/oversized.h`, '', '0', {declaredSize: 32 * 1024 * 1024 + 1, omitPayload: true}),
]);
archive('missing-layout.tar.gz', [
  ...entry(`${root}/`, '', '5'),
  ...entry(`${root}/include/node/node_api.h`, 'node api\n'),
  ...entry(`${root}/include/node/node.h`, 'node\n'),
]);

const valid = require('node:fs').readFileSync(path.join(output, 'valid.tar.gz'));
writeFileSync(path.join(output, 'truncated.tar.gz'), valid.subarray(0, Math.floor(valid.length / 2)));
writeFileSync(path.join(output, 'node.lib'), Buffer.from('mock pinned Windows import library\n'));
JS

valid_archive="$fixtures/valid.tar.gz"
lib_fixture="$fixtures/node.lib"
valid_headers_sha="$(sha256_file "$valid_archive")"
valid_lib_sha="$(sha256_file "$lib_fixture")"

fake_bin="$test_root/fake-bin"
mkdir -p "$fake_bin"
cat >"$fake_bin/node" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -eq 2 ] && [ "$1" = "-p" ] && [ "$2" = "process.versions.node" ]; then
  printf '%s\n' "$NODE_FALLBACK_TEST_RUNTIME_VERSION"
  exit 0
fi
exec "$NODE_FALLBACK_TEST_REAL_NODE" "$@"
SH
cat >"$fake_bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >>"$NODE_FALLBACK_TEST_CURL_LOG"
output=''
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
if [ -n "${NODE_FALLBACK_TEST_FINAL_MUST_BE_ABSENT:-}" ] && [ -e "$NODE_FALLBACK_TEST_FINAL_MUST_BE_ABSENT" ]; then
  echo "final cache path became visible before download completed" >&2
  exit 75
fi
case "${NODE_FALLBACK_TEST_CURL_MODE:-success}" in
  success)
    cp "$NODE_FALLBACK_TEST_CURL_SOURCE" "$output"
    ;;
  transport)
    printf 'partial transport bytes\n' >"$output"
    exit 56
    ;;
  interrupt)
    printf 'partial interrupted bytes\n' >"$output"
    kill -TERM "$PPID"
    sleep 1
    exit 143
    ;;
  *) exit 64 ;;
esac
SH
cat >"$fake_bin/mv" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ -n "${NODE_FALLBACK_TEST_MV_FAIL_DEST:-}" ] && [ "$#" -eq 2 ] &&
   [ "$2" = "$NODE_FALLBACK_TEST_MV_FAIL_DEST" ] && [[ "$1" == *.stage.* ]]; then
  exit 73
fi
exec /bin/mv "$@"
SH
chmod 0755 "$fake_bin"/*
real_node="$(command -v node)"

write_manifest() {
  local path="$1"
  local headers_sha="$2"
  local lib_sha="$3"
  local version="${4:-22.22.3}"
  cat >"$path" <<EOF
[toolchain]
version = "$version"

[headers]
url = "https://nodejs.org/download/release/v$version/node-v$version-headers.tar.gz"
sha256 = "$headers_sha"

[windows.x64]
url = "https://nodejs.org/download/release/v$version/win-x64/node.lib"
sha256 = "$lib_sha"
EOF
}

new_case() {
  CASE_NAME="$1"
  CASE_ROOT="$test_root/cases/$CASE_NAME"
  CASE_CACHE="$CASE_ROOT/cache"
  CASE_MANIFEST="$CASE_ROOT/node.toml"
  CASE_STDOUT="$CASE_ROOT/stdout"
  CASE_STDERR="$CASE_ROOT/stderr"
  CASE_CURL_LOG="$CASE_ROOT/curl.log"
  rm -rf "$CASE_ROOT"
  mkdir -p "$CASE_CACHE"
  : >"$CASE_CURL_LOG"
  write_manifest "$CASE_MANIFEST" "$valid_headers_sha" "$valid_lib_sha"
}

run_installer() {
  local source="$1"
  local mode="$2"
  local final_must_be_absent="$3"
  shift 3
  if env \
    PATH="$fake_bin:$PATH" \
    NODE_FALLBACK_TEST_REAL_NODE="$real_node" \
    NODE_FALLBACK_TEST_RUNTIME_VERSION="${CASE_RUNTIME_VERSION:-22.22.3}" \
    NODE_FALLBACK_TEST_CURL_LOG="$CASE_CURL_LOG" \
    NODE_FALLBACK_TEST_CURL_SOURCE="$source" \
    NODE_FALLBACK_TEST_CURL_MODE="$mode" \
    NODE_FALLBACK_TEST_FINAL_MUST_BE_ABSENT="$final_must_be_absent" \
    NODE_FALLBACK_TEST_MV_FAIL_DEST="${CASE_MV_FAIL_DEST:-}" \
    RUNNER_OS="${CASE_RUNNER_OS:-Linux}" \
    OLIPHAUNT_NODE_FALLBACK_ROOT="$root" \
    OLIPHAUNT_NODE_FALLBACK_MANIFEST="$CASE_MANIFEST" \
    OLIPHAUNT_NODE_FALLBACK_CACHE_ROOT="$CASE_CACHE" \
    OLIPHAUNT_NODE_HEADERS_EXTRACTOR="$extractor" \
    sh "$installer" "$@" >"$CASE_STDOUT" 2>"$CASE_STDERR"; then
    CASE_STATUS=0
  else
    CASE_STATUS=$?
  fi
}

new_case runtime-mismatch
CASE_RUNTIME_VERSION="22.22.2"
run_installer "$valid_archive" success '' headers
[ "$CASE_STATUS" -ne 0 ] || fail "runtime mismatch unexpectedly succeeded"
assert_contains "$CASE_STDERR" "active runtime is Node 22.22.2"
[ ! -s "$CASE_CURL_LOG" ] || fail "runtime mismatch reached curl"
unset CASE_RUNTIME_VERSION

new_case invalid-manifest
printf '\nunexpected = "metadata"\n' >>"$CASE_MANIFEST"
run_installer "$valid_archive" success '' headers
[ "$CASE_STATUS" -ne 0 ] || fail "unexpected manifest metadata was accepted"
[ ! -s "$CASE_CURL_LOG" ] || fail "invalid manifest reached curl"

new_case invalid-manifest-sha
write_manifest "$CASE_MANIFEST" "not-a-sha256" "$valid_lib_sha"
run_installer "$valid_archive" success '' headers
[ "$CASE_STATUS" -ne 0 ] || fail "invalid manifest SHA-256 was accepted"
[ ! -s "$CASE_CURL_LOG" ] || fail "invalid manifest SHA-256 reached curl"

new_case incomplete-manifest
sed '$d' "$CASE_MANIFEST" >"$CASE_MANIFEST.next"
mv "$CASE_MANIFEST.next" "$CASE_MANIFEST"
run_installer "$valid_archive" success '' headers
[ "$CASE_STATUS" -ne 0 ] || fail "incomplete manifest was accepted"
[ ! -s "$CASE_CURL_LOG" ] || fail "incomplete manifest reached curl"

new_case duplicate-manifest-section
printf '\n[headers]\nurl = "https://nodejs.org/download/release/v22.22.3/node-v22.22.3-headers.tar.gz"\nsha256 = "%s"\n' \
  "$valid_headers_sha" >>"$CASE_MANIFEST"
run_installer "$valid_archive" success '' headers
[ "$CASE_STATUS" -ne 0 ] || fail "duplicate manifest section was accepted"
[ ! -s "$CASE_CURL_LOG" ] || fail "duplicate manifest section reached curl"

new_case invalid-manifest-version
write_manifest "$CASE_MANIFEST" "$valid_headers_sha" "$valid_lib_sha" "22.latest.3"
run_installer "$valid_archive" success '' headers
[ "$CASE_STATUS" -ne 0 ] || fail "invalid manifest version was accepted"
[ ! -s "$CASE_CURL_LOG" ] || fail "invalid manifest version reached curl"

new_case wrong-url
sed 's#https://nodejs.org/download/release/#https://example.invalid/#' "$CASE_MANIFEST" >"$CASE_MANIFEST.next"
mv "$CASE_MANIFEST.next" "$CASE_MANIFEST"
run_installer "$valid_archive" success '' headers
[ "$CASE_STATUS" -ne 0 ] || fail "wrong manifest URL was accepted"
[ ! -s "$CASE_CURL_LOG" ] || fail "wrong manifest URL reached curl"

new_case headers-success
headers_final="$CASE_CACHE/node-headers/v22.22.3"
run_installer "$valid_archive" success "$headers_final" headers
[ "$CASE_STATUS" -eq 0 ] || fail "valid headers install failed: $(cat "$CASE_STDERR")"
[ "$(cat "$CASE_STDOUT")" = "$headers_final/include/node" ] || fail "headers install returned the wrong include directory"
for header in node_api.h node.h v8.h; do
  [ -s "$headers_final/include/node/$header" ] || fail "headers install omitted $header"
done
assert_contains "$headers_final/.oliphaunt-source.sha256" "archive_sha256=$valid_headers_sha"
assert_no_install_debris
for argument in \
  --fail \
  --location \
  --retry-all-errors \
  --retry-max-time \
  --connect-timeout \
  --max-time \
  --max-filesize \
  --remove-on-error \
  --proto \
  --proto-redir \
  '=https' \
  'https://nodejs.org/download/release/v22.22.3/node-v22.22.3-headers.tar.gz'; do
  assert_curl_arg "$argument"
done
if grep -Fx -- '--ssl-revoke-best-effort' "$CASE_CURL_LOG" >/dev/null; then
  fail "Linux Node headers transport unexpectedly used the Windows Schannel flag"
fi

: >"$CASE_CURL_LOG"
run_installer "$fixtures/does-not-exist" transport '' headers
[ "$CASE_STATUS" -eq 0 ] || fail "valid headers cache hit failed"
[ ! -s "$CASE_CURL_LOG" ] || fail "valid headers cache hit reached curl"

new_case corrupt-headers-cache
headers_final="$CASE_CACHE/node-headers/v22.22.3"
mkdir -p "$headers_final/include/node"
printf 'old corrupt cache\n' >"$headers_final/old-sentinel"
printf 'broken\n' >"$headers_final/include/node/node_api.h"
printf 'version=22.22.3\narchive_sha256=%s\n' "$valid_headers_sha" >"$headers_final/.oliphaunt-source.sha256"
run_installer "$valid_archive" success '' headers
[ "$CASE_STATUS" -eq 0 ] || fail "corrupt headers cache was not repaired: $(cat "$CASE_STDERR")"
[ ! -e "$headers_final/old-sentinel" ] || fail "corrupt headers cache contents survived promotion"
[ -s "$headers_final/include/node/v8.h" ] || fail "repaired headers cache is incomplete"
assert_no_install_debris

new_case headers-checksum-mismatch
write_manifest "$CASE_MANIFEST" "0000000000000000000000000000000000000000000000000000000000000000" "$valid_lib_sha"
headers_final="$CASE_CACHE/node-headers/v22.22.3"
run_installer "$valid_archive" success "$headers_final" headers
[ "$CASE_STATUS" -ne 0 ] || fail "headers checksum mismatch unexpectedly succeeded"
assert_contains "$CASE_STDERR" "headers checksum mismatch"
[ ! -e "$headers_final" ] || fail "checksum mismatch exposed a final headers cache"
assert_no_install_debris

for fixture_name in truncated traversal duplicate symlink oversized missing-layout; do
  new_case "headers-$fixture_name"
  fixture="$fixtures/$fixture_name.tar.gz"
  write_manifest "$CASE_MANIFEST" "$(sha256_file "$fixture")" "$valid_lib_sha"
  headers_final="$CASE_CACHE/node-headers/v22.22.3"
  run_installer "$fixture" success "$headers_final" headers
  [ "$CASE_STATUS" -ne 0 ] || fail "$fixture_name headers archive unexpectedly succeeded"
  [ ! -e "$headers_final" ] || fail "$fixture_name headers archive exposed a final cache"
  [ ! -e "$CASE_CACHE/escaped" ] || fail "$fixture_name headers archive escaped its staging root"
  assert_no_install_debris
done

new_case headers-transport-failure
headers_final="$CASE_CACHE/node-headers/v22.22.3"
run_installer "$valid_archive" transport "$headers_final" headers
[ "$CASE_STATUS" -ne 0 ] || fail "headers transport failure unexpectedly succeeded"
[ ! -e "$headers_final" ] || fail "transport failure exposed a final headers cache"
assert_no_install_debris

new_case headers-interruption
headers_final="$CASE_CACHE/node-headers/v22.22.3"
run_installer "$valid_archive" interrupt "$headers_final" headers
[ "$CASE_STATUS" -ne 0 ] || fail "interrupted headers download unexpectedly succeeded"
[ ! -e "$headers_final" ] || fail "interrupted download exposed a final headers cache"
assert_no_install_debris

new_case headers-promotion-rollback
headers_final="$CASE_CACHE/node-headers/v22.22.3"
mkdir -p "$headers_final"
printf 'previous cache\n' >"$headers_final/previous-sentinel"
CASE_MV_FAIL_DEST="$headers_final"
run_installer "$valid_archive" success '' headers
[ "$CASE_STATUS" -ne 0 ] || fail "forced headers promotion failure unexpectedly succeeded"
[ -f "$headers_final/previous-sentinel" ] || fail "headers promotion failure did not restore the previous cache"
assert_no_install_debris
unset CASE_MV_FAIL_DEST

new_case windows-lib-repair
CASE_RUNNER_OS=Windows
lib_final="$CASE_CACHE/node-lib/v22.22.3-win-x64/node.lib"
mkdir -p "$(dirname "$lib_final")"
printf 'corrupt import library\n' >"$lib_final"
run_installer "$lib_fixture" success "$lib_final" windows-lib x64
[ "$CASE_STATUS" -eq 0 ] || fail "corrupt node.lib cache was not repaired: $(cat "$CASE_STDERR")"
[ "$(sha256_file "$lib_final")" = "$valid_lib_sha" ] || fail "promoted node.lib has the wrong checksum"
[ "$(cat "$CASE_STDOUT")" = "$lib_final" ] || fail "node.lib install returned the wrong path"
assert_no_install_debris
assert_curl_arg --ssl-revoke-best-effort
if grep -E -x -- '--insecure|-k' "$CASE_CURL_LOG" >/dev/null; then
  fail "Windows node.lib transport disabled TLS validation"
fi

: >"$CASE_CURL_LOG"
run_installer "$fixtures/does-not-exist" transport '' windows-lib x64
[ "$CASE_STATUS" -eq 0 ] || fail "valid node.lib cache hit failed"
[ ! -s "$CASE_CURL_LOG" ] || fail "valid node.lib cache hit reached curl"

new_case windows-lib-checksum-mismatch
write_manifest "$CASE_MANIFEST" "$valid_headers_sha" "0000000000000000000000000000000000000000000000000000000000000000"
lib_final="$CASE_CACHE/node-lib/v22.22.3-win-x64/node.lib"
run_installer "$lib_fixture" success "$lib_final" windows-lib x64
[ "$CASE_STATUS" -ne 0 ] || fail "node.lib checksum mismatch unexpectedly succeeded"
[ ! -e "$lib_final" ] || fail "node.lib checksum mismatch exposed a final cache file"
assert_no_install_debris

new_case windows-lib-transport-failure
lib_final="$CASE_CACHE/node-lib/v22.22.3-win-x64/node.lib"
run_installer "$lib_fixture" transport "$lib_final" windows-lib x64
[ "$CASE_STATUS" -ne 0 ] || fail "node.lib transport failure unexpectedly succeeded"
[ ! -e "$lib_final" ] || fail "node.lib transport failure exposed a final cache file"
assert_no_install_debris

new_case unsupported-windows-arch
run_installer "$lib_fixture" success '' windows-lib arm64
[ "$CASE_STATUS" -ne 0 ] || fail "unpinned Windows arm64 node.lib fallback was accepted"
[ ! -s "$CASE_CURL_LOG" ] || fail "unsupported Windows architecture reached curl"
unset CASE_RUNNER_OS

[ -s "$production_manifest" ] || fail "production Node manifest is missing"

printf 'Node fallback installer fault tests passed\n'

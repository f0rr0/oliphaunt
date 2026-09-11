#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
installer="$root/.github/actions/setup-moon/install-pinned-toolchain.sh"
extractor="$root/.github/actions/setup-moon/toolchain-archive.mts"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "install-pinned-toolchain.test.sh: $*" >&2
  exit 1
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

fixture="$tmp/fixture"
mkdir -p \
  "$fixture/.moon" \
  "$fixture/tools/dev" \
  "$fixture/content" \
  "$fixture/blobs"
cp "$root/tools/dev/curl-platform-flags.sh" "$fixture/tools/dev/curl-platform-flags.sh"

moon_version="9.8.7"
proto_version="7.6.5"
moon_target="x86_64-unknown-linux-gnu"

printf '%s\n' '#!/bin/sh' "echo 'moon $moon_version'" >"$fixture/content/moon"
printf '%s\n' '#!/bin/sh' "echo 'moonx $moon_version'" >"$fixture/content/moonx"
chmod 0755 "$fixture/content/moon" "$fixture/content/moonx"
printf '%s\n' 'fixture readme' >"$fixture/content/README.md"
printf '%s\n' 'fixture changelog' >"$fixture/content/CHANGELOG.md"
printf '%s\n' 'fixture license' >"$fixture/content/LICENSE"

moon_archive="$fixture/moon.tar.xz"
bash "$root/tools/dev/bun.sh" - "$fixture/content" "$moon_archive" "$moon_target" <<'TS'
import {readFileSync,writeFileSync} from 'node:fs';
import {tarArchive} from './tools/packaging/testdata/tar-fixture.mts';
const [content, moonArchive, target] = process.argv.slice(2);
const moonRoot = 'moon_cli-' + target;
const moon = [{name:moonRoot+'/',type:'5',mode:0o755}];
for (const name of ['moon','moonx','README.md','CHANGELOG.md','LICENSE']) moon.push({name:moonRoot+'/'+name,data:readFileSync(content+'/'+name),mode:name.startsWith('moon')?0o755:0o644});
writeFileSync(moonArchive+'.gz',tarArchive(moon));

TS
gzip -dc "$moon_archive.gz" | xz -c >"$moon_archive"
rm "$moon_archive.gz"

moon_archive_sha256="$(sha256_file "$moon_archive")"
moon_archive_bytes="$(wc -c <"$moon_archive" | tr -d '[:space:]')"
moon_expanded_bytes="$(
  find "$fixture/content" -maxdepth 1 -type f \
    -exec sh -c 'for file do wc -c < "$file"; done' sh {} + |
    awk '{sum += $1} END {print sum}'
)"
moon_sha256="$(sha256_file "$fixture/content/moon")"
moonx_sha256="$(sha256_file "$fixture/content/moonx")"
cat >"$fixture/tools/dev/moon-cli.toml" <<EOF
[toolchain]
version = "$moon_version"

[assets.$moon_target]
url = "https://github.com/moonrepo/moon/releases/download/v$moon_version/moon_cli-$moon_target.tar.xz"
sha256 = "$moon_archive_sha256"
bytes = "$moon_archive_bytes"
expanded_bytes = "$moon_expanded_bytes"
format = "tar.xz"
prefix = "moon_cli-$moon_target"
entry_count = "6"
binary_path = "moon"
binary_sha256 = "$moon_sha256"
companion_path = "moonx"
companion_sha256 = "$moonx_sha256"
EOF

cat >"$fixture/tools/dev/proto.toml" <<EOF
[toolchain]
version = "$proto_version"
EOF

plugin_manifest="$fixture/tools/dev/moon-plugins.toml"
: >"$plugin_manifest"
moon_config="$fixture/.moon/toolchains.yml"
cat >"$moon_config" <<EOF
proto:
  version: "$proto_version"
EOF

index=0
for spec in \
  javascript:moonrepo/javascript_toolchain \
  node:moonrepo/node_toolchain \
  bun:moonrepo/bun_toolchain \
  rust:moonrepo/rust_toolchain; do
  plugin_id="${spec%%:*}"
  repository="${spec#*:}"
  index=$((index + 1))
  cache_hash="$(printf '%064d' "$((index + 10))")"
  printf 'fixture-%s\n' "$plugin_id" >"$fixture/blob-$plugin_id.wasm"
  blob_sha256="$(sha256_file "$fixture/blob-$plugin_id.wasm")"
  blob_bytes="$(wc -c <"$fixture/blob-$plugin_id.wasm" | tr -d '[:space:]')"
  cp "$fixture/blob-$plugin_id.wasm" "$fixture/blobs/$blob_sha256"
  printf '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","layers":[{"mediaType":"application/wasm","digest":"sha256:%s","size":%s}]}\n' \
    "$blob_sha256" "$blob_bytes" >"$fixture/manifest-$plugin_id.json"
  manifest_sha256="$(sha256_file "$fixture/manifest-$plugin_id.json")"
  manifest_bytes="$(wc -c <"$fixture/manifest-$plugin_id.json" | tr -d '[:space:]')"
  cp "$fixture/manifest-$plugin_id.json" "$fixture/blobs/$manifest_sha256.manifest"
  cat >>"$plugin_manifest" <<EOF
[plugins.$plugin_id]
locator = "registry://ghcr.io/$repository@sha256:$manifest_sha256"
repository = "$repository"
manifest_sha256 = "$manifest_sha256"
manifest_bytes = "$manifest_bytes"
blob_sha256 = "$blob_sha256"
bytes = "$blob_bytes"
cache_file = "$plugin_id-$cache_hash.wasm"

EOF
  cat >>"$moon_config" <<EOF
$plugin_id:
  plugin: "registry://ghcr.io/$repository@sha256:$manifest_sha256"
EOF
done

cat >"$fixture/.prototools" <<EOF
moon = "$moon_version"
EOF

fake_curl="$fixture/fake-curl"
cat >"$fake_curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
output=""
headers=""
url=""
printf 'CALL' >>"$FAKE_CURL_LOG"
printf ' %q' "$@" >>"$FAKE_CURL_LOG"
printf '\n' >>"$FAKE_CURL_LOG"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      output="$2"
      shift 2
      ;;
    --dump-header)
      headers="$2"
      shift 2
      ;;
    --header | --max-filesize | --retry | --retry-delay | --retry-max-time | --connect-timeout | --max-time | --speed-limit | --speed-time | --proto | --proto-redir)
      shift 2
      ;;
    https://*)
      url="$1"
      shift
      ;;
    *) shift ;;
  esac
done
[ -n "$output" ] && [ -n "$url" ] || exit 64
if [ "${FAKE_CURL_FAIL:-0}" = "1" ]; then
  exit 22
fi
case "$url" in
  https://ghcr.io/token?*) printf '%s\n' '{"token":"fixture-token=="}' >"$output" ;;
  https://ghcr.io/v2/*/manifests/sha256:*)
    digest="${url##*:}"
    cp "$FAKE_BLOB_DIR/$digest.manifest" "$output"
    printf 'HTTP/1.1 200 OK\r\ncontent-type: application/vnd.oci.image.manifest.v1+json\r\ndocker-content-digest: sha256:%s\r\n\r\n' "$digest" >"$headers"
    ;;
  https://ghcr.io/v2/*/blobs/sha256:*) cp "$FAKE_BLOB_DIR/${url##*:}" "$output" ;;
  https://github.com/moonrepo/moon/*) cp "$FAKE_MOON_ARCHIVE" "$output" ;;
  *) exit 65 ;;
esac
SH
chmod 0755 "$fake_curl"

export OLIPHAUNT_MOON_TOOLCHAIN_ROOT="$fixture"
export OLIPHAUNT_MOON_MANIFEST="$fixture/tools/dev/moon-cli.toml"
export OLIPHAUNT_PROTO_MANIFEST="$fixture/tools/dev/proto.toml"
export OLIPHAUNT_MOON_PLUGIN_MANIFEST="$plugin_manifest"
export OLIPHAUNT_MOON_PROTO_FILE="$fixture/.prototools"
export OLIPHAUNT_MOON_TOOLCHAINS_CONFIG="$moon_config"
export OLIPHAUNT_MOON_ARCHIVE_EXTRACTOR="$extractor"
export OLIPHAUNT_MOON_TOOLCHAIN_CACHE_ROOT="$tmp/cache with spaces"
export OLIPHAUNT_MOON_TOOLCHAIN_TARGET="$moon_target"
export OLIPHAUNT_MOON_TOOLCHAIN_TESTING=1
export OLIPHAUNT_MOON_CURL="$fake_curl"
export FAKE_CURL_LOG="$tmp/curl.log"
export FAKE_MOON_ARCHIVE="$moon_archive"
export FAKE_BLOB_DIR="$fixture/blobs"
export RUNNER_OS=Windows
: >"$FAKE_CURL_LOG"

final="$(bash "$installer")"
[ -d "$final" ] || fail "installer did not return an installation directory"
[ "$("$final/bin/moon" --version)" = "moon $moon_version" ] || fail "wrong Moon version"
[ "$(find "$final/plugins" -mindepth 1 -maxdepth 1 | wc -l | tr -d '[:space:]')" = "4" ] || fail "wrong plugin count"
[ "$(wc -l <"$FAKE_CURL_LOG" | tr -d '[:space:]')" = "13" ] || fail "unexpected first-install request count"
while IFS= read -r call; do
  for flag in --ssl-revoke-best-effort --tlsv1.2 --retry-all-errors --retry-connrefused --max-filesize --max-time --speed-limit; do
    [[ "$call" == *"$flag"* ]] || fail "curl request omitted $flag"
  done
done <"$FAKE_CURL_LOG"

# A fully valid cache must not consult the network at all.
OLIPHAUNT_MOON_CURL=false bash "$installer" >"$tmp/cache-hit"
[ "$(cat "$tmp/cache-hit")" = "$final" ] || fail "cache hit returned a different installation"

# Cache repair removes unexpected executables from PATH.
printf '%s\n' 'shadow node' >"$final/bin/node"
OLIPHAUNT_MOON_CURL=false bash "$installer" >"$tmp/repaired"
[ ! -e "$final/bin/node" ] || fail "cache repair retained an unexpected PATH entry"

# A corrupt cached archive is re-downloaded before rebuilding an invalid installation.
moon_cached="$OLIPHAUNT_MOON_TOOLCHAIN_CACHE_ROOT/archives/$moon_archive_sha256.tar.xz"
chmod u+w "$moon_cached"
printf '%s\n' corrupt >"$moon_cached"
chmod u+w "$final/bin/moon"
printf '%s\n' corrupt >"$final/bin/moon"
before_requests="$(wc -l <"$FAKE_CURL_LOG" | tr -d '[:space:]')"
bash "$installer" >"$tmp/archive-repaired"
after_requests="$(wc -l <"$FAKE_CURL_LOG" | tr -d '[:space:]')"
[ "$after_requests" -eq $((before_requests + 1)) ] || fail "corrupt archive repair did not make exactly one request"
[ "$("$final/bin/moon" --version)" = "moon $moon_version" ] || fail "corrupt archive repair failed"

# Promotion interruption restores the previous installation transactionally.
chmod u+w "$final/bin/moon"
printf '%s\n' 'previous installation' >"$final/bin/moon"
before_wrapper="$(sha256_file "$final/bin/moon")"
set +e
OLIPHAUNT_MOON_CURL=false \
  OLIPHAUNT_MOON_TOOLCHAIN_TEST_INTERRUPT_AFTER_BACKUP=1 \
  bash "$installer" >"$tmp/interrupted.out" 2>"$tmp/interrupted.err"
interrupt_status="$?"
set -e
[ "$interrupt_status" -eq 143 ] || fail "interruption hook returned $interrupt_status instead of 143"
[ "$(sha256_file "$final/bin/moon")" = "$before_wrapper" ] || fail "interrupted promotion did not restore the prior installation"
OLIPHAUNT_MOON_CURL=false bash "$installer" >/dev/null

echo "Pinned Moon toolchain bootstrap fault tests passed."

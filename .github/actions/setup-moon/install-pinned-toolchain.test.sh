#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
installer="$root/.github/actions/setup-moon/install-pinned-toolchain.sh"
extractor="$root/.github/actions/setup-moon/toolchain-archive.py"
action="$root/.github/actions/setup-moon/action.yml"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "install-pinned-toolchain.test.sh: $*" >&2
  exit 1
}

python=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then
    python="$candidate"
    break
  fi
done
[ -n "$python" ] || fail "python3 or python is required"
grep -Fq 'moon_home_fs="$(cygpath -u "$moon_home")"' "$action"
grep -Fq 'moon_home_env="$(cygpath -w "$moon_home_fs")"' "$action"
grep -Fq 'echo "MOON_HOME=$moon_home_env" >> "$GITHUB_ENV"' "$action"
grep -Fq 'export_dir_fs="$(cygpath -u "$export_dir")"' "$action"
grep -Fq 'github_path_entry="$(cygpath -w "$export_dir_fs")"' "$action"
grep -Fq 'cp "$binary" "$export_dir_fs/$(basename "$binary")"' "$action"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

sha512_file() {
  if command -v sha512sum >/dev/null 2>&1; then
    sha512sum "$1" | awk '{print $1}'
  else
    shasum -a 512 "$1" | awk '{print $1}'
  fi
}

fixture="$tmp/fixture"
mkdir -p \
  "$fixture/.moon" \
  "$fixture/src/sources/toolchains" \
  "$fixture/tools/dev" \
  "$fixture/content/pnpm/bin" \
  "$fixture/content/pnpm/dist/node-gyp-bin" \
  "$fixture/content/pnpm/dist/node_modules/node-gyp/bin" \
  "$fixture/blobs"
cp "$root/tools/dev/curl-platform-flags.sh" "$fixture/tools/dev/curl-platform-flags.sh"

moon_version="9.8.7"
pnpm_version="8.7.6"
proto_version="7.6.5"
moon_target="x86_64-unknown-linux-gnu"

printf '%s\n' '#!/bin/sh' "echo 'moon $moon_version'" >"$fixture/content/moon"
printf '%s\n' '#!/bin/sh' "echo 'moonx $moon_version'" >"$fixture/content/moonx"
chmod 0755 "$fixture/content/moon" "$fixture/content/moonx"
printf '%s\n' 'fixture readme' >"$fixture/content/README.md"
printf '%s\n' 'fixture changelog' >"$fixture/content/CHANGELOG.md"
printf '%s\n' 'fixture license' >"$fixture/content/LICENSE"

printf '%s\n' '#!/usr/bin/env node' "console.log('$pnpm_version');" >"$fixture/content/pnpm/bin/pnpm.mjs"
printf '%s\n' '#!/usr/bin/env node' "console.log('$pnpm_version');" >"$fixture/content/pnpm/bin/pnpx.mjs"
printf '%s\n' 'fixture pnpm payload' >"$fixture/content/pnpm/dist/pnpm.mjs"
printf '%s\n' '#!/bin/sh' 'exit 0' >"$fixture/content/pnpm/dist/node-gyp-bin/node-gyp"
printf '%s\r\n' '@exit /b 0' >"$fixture/content/pnpm/dist/node-gyp-bin/node-gyp.cmd"
printf '%s\n' '#!/usr/bin/env node' >"$fixture/content/pnpm/dist/node_modules/node-gyp/bin/node-gyp.js"
printf '%s\n' '{"name":"pnpm-fixture"}' >"$fixture/content/pnpm/package.json"
chmod 0755 \
  "$fixture/content/pnpm/bin/pnpm.mjs" \
  "$fixture/content/pnpm/bin/pnpx.mjs" \
  "$fixture/content/pnpm/dist/node-gyp-bin/node-gyp" \
  "$fixture/content/pnpm/dist/node-gyp-bin/node-gyp.cmd" \
  "$fixture/content/pnpm/dist/node_modules/node-gyp/bin/node-gyp.js"

moon_archive="$fixture/moon.tar.xz"
pnpm_archive="$fixture/pnpm.tgz"
"$python" - "$fixture/content" "$moon_archive" "$pnpm_archive" "$moon_target" <<'PY'
import io
import pathlib
import tarfile
import sys

content = pathlib.Path(sys.argv[1])
moon_archive = pathlib.Path(sys.argv[2])
pnpm_archive = pathlib.Path(sys.argv[3])
target = sys.argv[4]

with tarfile.open(moon_archive, "w:xz", format=tarfile.PAX_FORMAT) as archive:
    root = tarfile.TarInfo(f"moon_cli-{target}")
    root.type = tarfile.DIRTYPE
    root.mode = 0o755
    archive.addfile(root)
    for name, mode in [
        ("moon", 0o755),
        ("moonx", 0o755),
        ("README.md", 0o644),
        ("CHANGELOG.md", 0o644),
        ("LICENSE", 0o644),
    ]:
        payload = (content / name).read_bytes()
        info = tarfile.TarInfo(f"moon_cli-{target}/{name}")
        info.mode = mode
        info.size = len(payload)
        archive.addfile(info, io.BytesIO(payload))

pnpm = content / "pnpm"
with tarfile.open(pnpm_archive, "w:gz", format=tarfile.PAX_FORMAT) as archive:
    root = tarfile.TarInfo("package")
    root.type = tarfile.DIRTYPE
    root.mode = 0o755
    archive.addfile(root)
    for path in sorted(candidate for candidate in pnpm.rglob("*") if candidate.is_file()):
        relative = path.relative_to(pnpm).as_posix()
        payload = path.read_bytes()
        info = tarfile.TarInfo(f"package/{relative}")
        info.mode = path.stat().st_mode & 0o777
        info.size = len(payload)
        archive.addfile(info, io.BytesIO(payload))
PY

moon_archive_sha256="$(sha256_file "$moon_archive")"
moon_archive_bytes="$(wc -c <"$moon_archive" | tr -d '[:space:]')"
moon_expanded_bytes="$(find "$fixture/content" -maxdepth 1 -type f -printf '%s\n' | awk '{sum += $1} END {print sum}')"
moon_sha256="$(sha256_file "$fixture/content/moon")"
moonx_sha256="$(sha256_file "$fixture/content/moonx")"
pnpm_archive_sha256="$(sha256_file "$pnpm_archive")"
pnpm_archive_sha512="$(sha512_file "$pnpm_archive")"
pnpm_archive_bytes="$(wc -c <"$pnpm_archive" | tr -d '[:space:]')"
pnpm_expanded_bytes="$(find "$fixture/content/pnpm" -type f -printf '%s\n' | awk '{sum += $1} END {print sum}')"
pnpm_tree_result="$("$python" "$extractor" tree-digest \
  --root "$fixture/content/pnpm" \
  --executable bin/pnpm.mjs \
  --executable bin/pnpx.mjs \
  --executable dist/node-gyp-bin/node-gyp \
  --executable dist/node-gyp-bin/node-gyp.cmd \
  --executable dist/node_modules/node-gyp/bin/node-gyp.js)"
pnpm_tree_sha256="${pnpm_tree_result#* }"
pnpm_binary_sha256="$(sha256_file "$fixture/content/pnpm/bin/pnpm.mjs")"
pnpm_companion_sha256="$(sha256_file "$fixture/content/pnpm/bin/pnpx.mjs")"
pnpm_payload_sha256="$(sha256_file "$fixture/content/pnpm/dist/pnpm.mjs")"

cat >"$fixture/src/sources/toolchains/moon-cli.toml" <<EOF
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

cat >"$fixture/src/sources/toolchains/pnpm.toml" <<EOF
[toolchain]
version = "$pnpm_version"

[package]
url = "https://registry.npmjs.org/pnpm/-/pnpm-$pnpm_version.tgz"
sha256 = "$pnpm_archive_sha256"
sha512 = "$pnpm_archive_sha512"
bytes = "$pnpm_archive_bytes"
expanded_bytes = "$pnpm_expanded_bytes"
format = "tar.gz"
prefix = "package"
entry_count = "8"
file_count = "7"
tree_sha256 = "$pnpm_tree_sha256"
executable_paths = "bin/pnpm.mjs,bin/pnpx.mjs,dist/node-gyp-bin/node-gyp,dist/node-gyp-bin/node-gyp.cmd,dist/node_modules/node-gyp/bin/node-gyp.js"
binary_path = "bin/pnpm.mjs"
binary_sha256 = "$pnpm_binary_sha256"
companion_path = "bin/pnpx.mjs"
companion_sha256 = "$pnpm_companion_sha256"
payload_path = "dist/pnpm.mjs"
payload_sha256 = "$pnpm_payload_sha256"
EOF

cat >"$fixture/src/sources/toolchains/proto.toml" <<EOF
[toolchain]
version = "$proto_version"
EOF

plugin_manifest="$fixture/src/sources/toolchains/moon-plugins.toml"
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
  pnpm:moonrepo/node_depman_toolchain \
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
pnpm = "$pnpm_version"
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
  https://registry.npmjs.org/pnpm/*) cp "$FAKE_PNPM_ARCHIVE" "$output" ;;
  *) exit 65 ;;
esac
SH
chmod 0755 "$fake_curl"

export OLIPHAUNT_MOON_TOOLCHAIN_ROOT="$fixture"
export OLIPHAUNT_MOON_MANIFEST="$fixture/src/sources/toolchains/moon-cli.toml"
export OLIPHAUNT_PNPM_MANIFEST="$fixture/src/sources/toolchains/pnpm.toml"
export OLIPHAUNT_PROTO_MANIFEST="$fixture/src/sources/toolchains/proto.toml"
export OLIPHAUNT_MOON_PLUGIN_MANIFEST="$plugin_manifest"
export OLIPHAUNT_MOON_PROTO_FILE="$fixture/.prototools"
export OLIPHAUNT_MOON_TOOLCHAINS_CONFIG="$moon_config"
export OLIPHAUNT_MOON_ARCHIVE_EXTRACTOR="$extractor"
export OLIPHAUNT_MOON_TOOLCHAIN_CACHE_ROOT="$tmp/cache"
export OLIPHAUNT_MOON_TOOLCHAIN_TARGET="$moon_target"
export OLIPHAUNT_MOON_TOOLCHAIN_TESTING=1
export OLIPHAUNT_MOON_CURL="$fake_curl"
export FAKE_CURL_LOG="$tmp/curl.log"
export FAKE_MOON_ARCHIVE="$moon_archive"
export FAKE_PNPM_ARCHIVE="$pnpm_archive"
export FAKE_BLOB_DIR="$fixture/blobs"
export RUNNER_OS=Windows
: >"$FAKE_CURL_LOG"

final="$(bash "$installer")"
[ -d "$final" ] || fail "installer did not return an installation directory"
[ "$("$final/bin/moon" --version)" = "moon $moon_version" ] || fail "wrong Moon version"
[ "$("$final/bin/pnpm" --version)" = "$pnpm_version" ] || fail "wrong pnpm version"
[ "$(find "$final/plugins" -mindepth 1 -maxdepth 1 | wc -l | tr -d '[:space:]')" = "4" ] || fail "wrong plugin count"
[ "$(wc -l <"$FAKE_CURL_LOG" | tr -d '[:space:]')" = "14" ] || fail "unexpected first-install request count"
while IFS= read -r call; do
  for flag in --ssl-revoke-best-effort --tlsv1.2 --retry-all-errors --retry-connrefused --max-filesize --max-time --speed-limit; do
    [[ "$call" == *"$flag"* ]] || fail "curl request omitted $flag"
  done
done <"$FAKE_CURL_LOG"

# A fully valid cache must not consult the network at all.
OLIPHAUNT_MOON_CURL=false bash "$installer" >"$tmp/cache-hit"
[ "$(cat "$tmp/cache-hit")" = "$final" ] || fail "cache hit returned a different installation"

# Full-tree validation repairs unpinned PATH entries and non-component pnpm files.
chmod u+w "$final/bin/pnpm"
printf '%s\n' 'malicious wrapper' >"$final/bin/pnpm"
printf '%s\n' 'shadow node' >"$final/bin/node"
printf '%s\n' 'mutated package metadata' >"$final/pnpm/package.json"
OLIPHAUNT_MOON_CURL=false bash "$installer" >"$tmp/repaired"
[ ! -e "$final/bin/node" ] || fail "cache repair retained an unexpected PATH entry"
[ "$("$final/bin/pnpm" --version)" = "$pnpm_version" ] || fail "cache repair did not restore pnpm"
grep -Fq 'pnpm-fixture' "$final/pnpm/package.json" || fail "tree-digest repair did not restore package metadata"

# A corrupt cached archive is re-downloaded before rebuilding an invalid installation.
moon_cached="$tmp/cache/archives/$moon_archive_sha256.tar.xz"
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
chmod u+w "$final/bin/pnpm"
printf '%s\n' 'previous installation' >"$final/bin/pnpm"
before_wrapper="$(sha256_file "$final/bin/pnpm")"
set +e
OLIPHAUNT_MOON_CURL=false \
  OLIPHAUNT_MOON_TOOLCHAIN_TEST_INTERRUPT_AFTER_BACKUP=1 \
  bash "$installer" >"$tmp/interrupted.out" 2>"$tmp/interrupted.err"
interrupt_status="$?"
set -e
[ "$interrupt_status" -eq 143 ] || fail "interruption hook returned $interrupt_status instead of 143"
[ "$(sha256_file "$final/bin/pnpm")" = "$before_wrapper" ] || fail "interrupted promotion did not restore the prior installation"
OLIPHAUNT_MOON_CURL=false bash "$installer" >/dev/null

# Executable intent is part of the portable tree fingerprint on POSIX.
chmod 0644 "$final/pnpm/bin/pnpm.mjs"
set +e
"$python" "$extractor" tree-digest \
  --root "$final/pnpm" \
  --executable bin/pnpm.mjs \
  --executable bin/pnpx.mjs \
  --executable dist/node-gyp-bin/node-gyp \
  --executable dist/node-gyp-bin/node-gyp.cmd \
  --executable dist/node_modules/node-gyp/bin/node-gyp.js >/dev/null 2>"$tmp/mode.err"
mode_status="$?"
set -e
[ "$mode_status" -ne 0 ] || fail "tree digest accepted executable-mode drift"
chmod 0755 "$final/pnpm/bin/pnpm.mjs"

# Reject traversal and non-zero directory payload metadata before extraction.
"$python" - "$tmp/unsafe.tar.xz" "$tmp/directory-payload.tar.xz" "$tmp/pax-payload.tar.xz" <<'PY'
import io
import tarfile
import sys

with tarfile.open(sys.argv[1], "w:xz") as archive:
    root = tarfile.TarInfo("root")
    root.type = tarfile.DIRTYPE
    archive.addfile(root)
    payload = b"x"
    bad = tarfile.TarInfo("root/../escape")
    bad.size = len(payload)
    archive.addfile(bad, io.BytesIO(payload))

with tarfile.open(sys.argv[2], "w:xz") as archive:
    root = tarfile.TarInfo("root")
    root.type = tarfile.DIRTYPE
    root.size = 1
    archive.addfile(root, io.BytesIO(b"x"))
    payload = b"x"
    regular = tarfile.TarInfo("root/file")
    regular.size = len(payload)
    archive.addfile(regular, io.BytesIO(payload))

# Extended metadata is rejected from the raw stream before a decompression bomb
# can be materialized by tarfile's PAX parser.
with tarfile.open(sys.argv[3], "w:xz", format=tarfile.PAX_FORMAT) as archive:
    payload = b"x"
    regular = tarfile.TarInfo("root/file")
    regular.size = len(payload)
    regular.pax_headers = {"comment": "x" * (2 * 1024 * 1024)}
    archive.addfile(regular, io.BytesIO(payload))
PY

for unsafe in "$tmp/unsafe.tar.xz" "$tmp/directory-payload.tar.xz" "$tmp/pax-payload.tar.xz"; do
  set +e
  "$python" "$extractor" extract \
    --archive "$unsafe" \
    --format tar.xz \
    --prefix root \
    --entry-count 2 \
    --expected-bytes "$(wc -c <"$unsafe" | tr -d '[:space:]')" \
    --expanded-bytes 1 \
    --destination "$unsafe.out" \
    --required file >/dev/null 2>"$tmp/unsafe.err"
  unsafe_status="$?"
  set -e
  [ "$unsafe_status" -ne 0 ] || fail "unsafe archive was accepted: $unsafe"
  [ ! -e "$unsafe.out" ] || fail "unsafe archive left a partial extraction tree"
done

echo "Pinned Moon toolchain bootstrap fault tests passed."

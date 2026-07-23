#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "install-pinned-toolchain.sh: $*" >&2
  exit 1
}

root="${OLIPHAUNT_MOON_TOOLCHAIN_ROOT:-}"
if [ -z "$root" ]; then
  root="$(git rev-parse --show-toplevel 2>/dev/null)" ||
    fail "must run inside the Oliphaunt checkout"
fi

action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
moon_manifest="${OLIPHAUNT_MOON_MANIFEST:-$root/src/sources/toolchains/moon-cli.toml}"
pnpm_manifest="${OLIPHAUNT_PNPM_MANIFEST:-$root/src/sources/toolchains/pnpm.toml}"
proto_manifest="${OLIPHAUNT_PROTO_MANIFEST:-$root/src/sources/toolchains/proto.toml}"
plugin_manifest="${OLIPHAUNT_MOON_PLUGIN_MANIFEST:-$root/src/sources/toolchains/moon-plugins.toml}"
proto_file="${OLIPHAUNT_MOON_PROTO_FILE:-$root/.prototools}"
moon_config="${OLIPHAUNT_MOON_TOOLCHAINS_CONFIG:-$root/.moon/toolchains.yml}"
extractor="${OLIPHAUNT_MOON_ARCHIVE_EXTRACTOR:-$action_dir/toolchain-archive.py}"
curl_platform_flags="$root/tools/dev/curl-platform-flags.sh"
cache_root="${OLIPHAUNT_MOON_TOOLCHAIN_CACHE_ROOT:-${RUNNER_TEMP:-$root/target}/oliphaunt-moon-toolchain}"

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    if command -v cygpath >/dev/null 2>&1; then
      cache_root="$(cygpath -u "$cache_root")"
    fi
    ;;
esac

for path in \
  "$moon_manifest" \
  "$pnpm_manifest" \
  "$proto_manifest" \
  "$plugin_manifest" \
  "$proto_file" \
  "$moon_config" \
  "$extractor" \
  "$curl_platform_flags"; do
  [ -f "$path" ] && [ ! -L "$path" ] || fail "missing regular bootstrap input: $path"
done

# shellcheck source=tools/dev/curl-platform-flags.sh
. "$curl_platform_flags"

python=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then
    python="$candidate"
    break
  fi
done
[ -n "$python" ] || fail "python3 or python is required for safe archive extraction"

manifest_value() {
  local manifest="$1"
  local section="$2"
  local key="$3"
  awk -v wanted_section="$section" -v wanted_key="$key" '
    /^[[:space:]]*\[[^]]+\][[:space:]]*$/ {
      current=$0
      gsub(/^[[:space:]]*\[|\][[:space:]]*$/, "", current)
      next
    }
    current == wanted_section && $0 ~ "^[[:space:]]*" wanted_key "[[:space:]]*=" {
      count++
      line=$0
      sub(/^[^=]*=[[:space:]]*"/, "", line)
      sub(/"[[:space:]]*$/, "", line)
      value=line
    }
    END {
      if (count != 1 || value == "") exit 1
      print value
    }
  ' "$manifest"
}

prototool_version() {
  local tool="$1"
  awk -F '=' -v wanted="$tool" '
    $1 ~ "^[[:space:]]*" wanted "[[:space:]]*$" {
      count++
      value=$2
      gsub(/^[[:space:]"]+|[[:space:]"]+$/, "", value)
    }
    END { if (count != 1 || value == "") exit 1; print value }
  ' "$proto_file"
}

moon_proto_version() {
  awk '
    /^[[:space:]]*proto:[[:space:]]*$/ { proto_count++; in_proto=1; next }
    in_proto && /^[^[:space:]]/ { in_proto=0 }
    in_proto && /^[[:space:]]+version:[[:space:]]*"[^"]+"[[:space:]]*$/ {
      version_count++
      line=$0
      sub(/^[^:]*:[[:space:]]*"/, "", line)
      sub(/"[[:space:]]*$/, "", line)
      value=line
    }
    END {
      if (proto_count != 1 || version_count != 1 || value == "") exit 1
      print value
    }
  ' "$moon_config"
}

validate_version() {
  local label="$1"
  local version="$2"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "invalid $label version: $version"
}

validate_digest() {
  local label="$1"
  local digest="$2"
  [ "${#digest}" -eq 64 ] && [[ ! "$digest" =~ [^0-9a-f] ]] ||
    fail "$label must contain exactly 64 lowercase hexadecimal characters"
}

validate_sha512() {
  local label="$1"
  local digest="$2"
  [ "${#digest}" -eq 128 ] && [[ ! "$digest" =~ [^0-9a-f] ]] ||
    fail "$label must contain exactly 128 lowercase hexadecimal characters"
}

validate_count() {
  local label="$1"
  local value="$2"
  case "$value" in
    '' | *[!0-9]*) fail "$label must be a positive integer" ;;
  esac
  [ "$value" -gt 0 ] || fail "$label must be a positive integer"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    "$python" - "$1" <<'PY'
import hashlib
import pathlib
import sys

digest = hashlib.sha256()
with pathlib.Path(sys.argv[1]).open("rb") as stream:
    while block := stream.read(1024 * 1024):
        digest.update(block)
print(digest.hexdigest())
PY
  fi
}

sha512_file() {
  if command -v sha512sum >/dev/null 2>&1; then
    sha512sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 512 "$1" | awk '{print $1}'
  else
    "$python" - "$1" <<'PY'
import hashlib
import pathlib
import sys

digest = hashlib.sha512()
with pathlib.Path(sys.argv[1]).open("rb") as stream:
    while block := stream.read(1024 * 1024):
        digest.update(block)
print(digest.hexdigest())
PY
  fi
}

moon_version="$(manifest_value "$moon_manifest" toolchain version)" ||
  fail "$moon_manifest must contain exactly one quoted toolchain.version"
pnpm_version="$(manifest_value "$pnpm_manifest" toolchain version)" ||
  fail "$pnpm_manifest must contain exactly one quoted toolchain.version"
proto_version="$(manifest_value "$proto_manifest" toolchain version)" ||
  fail "$proto_manifest must contain exactly one quoted toolchain.version"
validate_version Moon "$moon_version"
validate_version pnpm "$pnpm_version"
validate_version proto "$proto_version"

for tool in moon pnpm; do
  configured="$(prototool_version "$tool")" ||
    fail "$proto_file must contain exactly one $tool version"
  configured="${configured#v}"
  case "$tool" in
    moon) expected="$moon_version" ;;
    pnpm) expected="$pnpm_version" ;;
  esac
  [ "$configured" = "$expected" ] ||
    fail "$proto_file $tool version $configured does not match pinned version $expected"
done
configured_proto="$(moon_proto_version)" ||
  fail "$moon_config must contain exactly one quoted proto.version"
configured_proto="${configured_proto#v}"
[ "$configured_proto" = "$proto_version" ] ||
  fail "$moon_config proto version $configured_proto does not match pinned version $proto_version"

if [ -n "${OLIPHAUNT_MOON_TOOLCHAIN_TARGET:-}" ]; then
  [ "${OLIPHAUNT_MOON_TOOLCHAIN_TESTING:-0}" = "1" ] ||
    fail "OLIPHAUNT_MOON_TOOLCHAIN_TARGET is test-only"
  target="$OLIPHAUNT_MOON_TOOLCHAIN_TARGET"
else
  case "$(uname -s):$(uname -m)" in
    Darwin:arm64 | Darwin:aarch64) target="aarch64-apple-darwin" ;;
    Darwin:x86_64) target="x86_64-apple-darwin" ;;
    Linux:arm64 | Linux:aarch64) target="aarch64-unknown-linux-gnu" ;;
    Linux:x86_64) target="x86_64-unknown-linux-gnu" ;;
    MINGW*:x86_64 | MSYS*:x86_64 | CYGWIN*:x86_64 | MINGW*:AMD64 | MSYS*:AMD64 | CYGWIN*:AMD64)
      target="x86_64-pc-windows-msvc"
      ;;
    *) fail "unsupported Moon host: $(uname -s)-$(uname -m)" ;;
  esac
fi

moon_section="assets.$target"
moon_url="$(manifest_value "$moon_manifest" "$moon_section" url)" || fail "$moon_manifest is missing $moon_section.url"
moon_archive_sha256="$(manifest_value "$moon_manifest" "$moon_section" sha256)" || fail "$moon_manifest is missing $moon_section.sha256"
moon_archive_bytes="$(manifest_value "$moon_manifest" "$moon_section" bytes)" || fail "$moon_manifest is missing $moon_section.bytes"
moon_expanded_bytes="$(manifest_value "$moon_manifest" "$moon_section" expanded_bytes)" || fail "$moon_manifest is missing $moon_section.expanded_bytes"
moon_format="$(manifest_value "$moon_manifest" "$moon_section" format)" || fail "$moon_manifest is missing $moon_section.format"
moon_prefix="$(manifest_value "$moon_manifest" "$moon_section" prefix)" || fail "$moon_manifest is missing $moon_section.prefix"
moon_entry_count="$(manifest_value "$moon_manifest" "$moon_section" entry_count)" || fail "$moon_manifest is missing $moon_section.entry_count"
moon_binary_path="$(manifest_value "$moon_manifest" "$moon_section" binary_path)" || fail "$moon_manifest is missing $moon_section.binary_path"
moon_binary_sha256="$(manifest_value "$moon_manifest" "$moon_section" binary_sha256)" || fail "$moon_manifest is missing $moon_section.binary_sha256"
moon_companion_path="$(manifest_value "$moon_manifest" "$moon_section" companion_path)" || fail "$moon_manifest is missing $moon_section.companion_path"
moon_companion_sha256="$(manifest_value "$moon_manifest" "$moon_section" companion_sha256)" || fail "$moon_manifest is missing $moon_section.companion_sha256"

case "$target" in
  x86_64-pc-windows-msvc)
    expected_moon_format="zip"
    expected_moon_prefix="."
    expected_moon_binary="moon.exe"
    expected_moon_companion="moonx.exe"
    expected_moon_entries="5"
    moon_archive_suffix="zip"
    moon_archive_executables=()
    ;;
  aarch64-apple-darwin | x86_64-apple-darwin | aarch64-unknown-linux-gnu | x86_64-unknown-linux-gnu)
    expected_moon_format="tar.xz"
    expected_moon_prefix="moon_cli-$target"
    expected_moon_binary="moon"
    expected_moon_companion="moonx"
    expected_moon_entries="6"
    moon_archive_suffix="tar.xz"
    moon_archive_executables=("$expected_moon_binary" "$expected_moon_companion")
    ;;
  *) fail "unsupported pinned Moon target: $target" ;;
esac
expected_moon_url="https://github.com/moonrepo/moon/releases/download/v$moon_version/moon_cli-$target.$moon_archive_suffix"
[ "$moon_url" = "$expected_moon_url" ] || fail "$moon_manifest $moon_section.url must be $expected_moon_url"
[ "$moon_format" = "$expected_moon_format" ] || fail "$moon_manifest $moon_section.format must be $expected_moon_format"
[ "$moon_prefix" = "$expected_moon_prefix" ] || fail "$moon_manifest $moon_section.prefix must be $expected_moon_prefix"
[ "$moon_binary_path" = "$expected_moon_binary" ] || fail "$moon_manifest $moon_section.binary_path must be $expected_moon_binary"
[ "$moon_companion_path" = "$expected_moon_companion" ] || fail "$moon_manifest $moon_section.companion_path must be $expected_moon_companion"
[ "$moon_entry_count" = "$expected_moon_entries" ] || fail "$moon_manifest $moon_section.entry_count must be $expected_moon_entries"
for digest in "$moon_archive_sha256" "$moon_binary_sha256" "$moon_companion_sha256"; do
  validate_digest "$moon_manifest $moon_section digest" "$digest"
done
for value in "$moon_archive_bytes" "$moon_expanded_bytes" "$moon_entry_count"; do
  validate_count "$moon_manifest $moon_section count" "$value"
done

pnpm_url="$(manifest_value "$pnpm_manifest" package url)" || fail "$pnpm_manifest is missing package.url"
pnpm_archive_sha256="$(manifest_value "$pnpm_manifest" package sha256)" || fail "$pnpm_manifest is missing package.sha256"
pnpm_archive_sha512="$(manifest_value "$pnpm_manifest" package sha512)" || fail "$pnpm_manifest is missing package.sha512"
pnpm_archive_bytes="$(manifest_value "$pnpm_manifest" package bytes)" || fail "$pnpm_manifest is missing package.bytes"
pnpm_expanded_bytes="$(manifest_value "$pnpm_manifest" package expanded_bytes)" || fail "$pnpm_manifest is missing package.expanded_bytes"
pnpm_format="$(manifest_value "$pnpm_manifest" package format)" || fail "$pnpm_manifest is missing package.format"
pnpm_prefix="$(manifest_value "$pnpm_manifest" package prefix)" || fail "$pnpm_manifest is missing package.prefix"
pnpm_entry_count="$(manifest_value "$pnpm_manifest" package entry_count)" || fail "$pnpm_manifest is missing package.entry_count"
pnpm_file_count="$(manifest_value "$pnpm_manifest" package file_count)" || fail "$pnpm_manifest is missing package.file_count"
pnpm_tree_sha256="$(manifest_value "$pnpm_manifest" package tree_sha256)" || fail "$pnpm_manifest is missing package.tree_sha256"
pnpm_executable_paths="$(manifest_value "$pnpm_manifest" package executable_paths)" || fail "$pnpm_manifest is missing package.executable_paths"
pnpm_binary_path="$(manifest_value "$pnpm_manifest" package binary_path)" || fail "$pnpm_manifest is missing package.binary_path"
pnpm_binary_sha256="$(manifest_value "$pnpm_manifest" package binary_sha256)" || fail "$pnpm_manifest is missing package.binary_sha256"
pnpm_companion_path="$(manifest_value "$pnpm_manifest" package companion_path)" || fail "$pnpm_manifest is missing package.companion_path"
pnpm_companion_sha256="$(manifest_value "$pnpm_manifest" package companion_sha256)" || fail "$pnpm_manifest is missing package.companion_sha256"
pnpm_payload_path="$(manifest_value "$pnpm_manifest" package payload_path)" || fail "$pnpm_manifest is missing package.payload_path"
pnpm_payload_sha256="$(manifest_value "$pnpm_manifest" package payload_sha256)" || fail "$pnpm_manifest is missing package.payload_sha256"

expected_pnpm_url="https://registry.npmjs.org/pnpm/-/pnpm-$pnpm_version.tgz"
[ "$pnpm_url" = "$expected_pnpm_url" ] || fail "$pnpm_manifest package.url must be $expected_pnpm_url"
[ "$pnpm_format" = "tar.gz" ] || fail "$pnpm_manifest package.format must be tar.gz"
[ "$pnpm_prefix" = "package" ] || fail "$pnpm_manifest package.prefix must be package"
[ "$pnpm_binary_path" = "bin/pnpm.mjs" ] || fail "$pnpm_manifest package.binary_path must be bin/pnpm.mjs"
[ "$pnpm_companion_path" = "bin/pnpx.mjs" ] || fail "$pnpm_manifest package.companion_path must be bin/pnpx.mjs"
[ "$pnpm_payload_path" = "dist/pnpm.mjs" ] || fail "$pnpm_manifest package.payload_path must be dist/pnpm.mjs"
expected_pnpm_executable_paths="bin/pnpm.mjs,bin/pnpx.mjs,dist/node-gyp-bin/node-gyp,dist/node-gyp-bin/node-gyp.cmd,dist/node_modules/node-gyp/bin/node-gyp.js"
[ "$pnpm_executable_paths" = "$expected_pnpm_executable_paths" ] ||
  fail "$pnpm_manifest package.executable_paths must be $expected_pnpm_executable_paths"
IFS=',' read -r -a pnpm_executables <<<"$pnpm_executable_paths"
for digest in "$pnpm_archive_sha256" "$pnpm_tree_sha256" "$pnpm_binary_sha256" "$pnpm_companion_sha256" "$pnpm_payload_sha256"; do
  validate_digest "$pnpm_manifest package digest" "$digest"
done
validate_sha512 "$pnpm_manifest package.sha512" "$pnpm_archive_sha512"
for value in "$pnpm_archive_bytes" "$pnpm_expanded_bytes" "$pnpm_entry_count" "$pnpm_file_count"; do
  validate_count "$pnpm_manifest package count" "$value"
done

plugin_records=()
for plugin_id in javascript node pnpm rust; do
  section="plugins.$plugin_id"
  locator="$(manifest_value "$plugin_manifest" "$section" locator)" || fail "$plugin_manifest is missing $section.locator"
  repository="$(manifest_value "$plugin_manifest" "$section" repository)" || fail "$plugin_manifest is missing $section.repository"
  manifest_sha256="$(manifest_value "$plugin_manifest" "$section" manifest_sha256)" || fail "$plugin_manifest is missing $section.manifest_sha256"
  manifest_bytes="$(manifest_value "$plugin_manifest" "$section" manifest_bytes)" || fail "$plugin_manifest is missing $section.manifest_bytes"
  blob_sha256="$(manifest_value "$plugin_manifest" "$section" blob_sha256)" || fail "$plugin_manifest is missing $section.blob_sha256"
  blob_bytes="$(manifest_value "$plugin_manifest" "$section" bytes)" || fail "$plugin_manifest is missing $section.bytes"
  cache_file="$(manifest_value "$plugin_manifest" "$section" cache_file)" || fail "$plugin_manifest is missing $section.cache_file"
  case "$plugin_id" in
    javascript) expected_repository="moonrepo/javascript_toolchain" ;;
    node) expected_repository="moonrepo/node_toolchain" ;;
    pnpm) expected_repository="moonrepo/node_depman_toolchain" ;;
    rust) expected_repository="moonrepo/rust_toolchain" ;;
  esac
  [ "$repository" = "$expected_repository" ] || fail "$plugin_manifest $section.repository must be $expected_repository"
  validate_digest "$plugin_manifest $section.manifest_sha256" "$manifest_sha256"
  validate_count "$plugin_manifest $section.manifest_bytes" "$manifest_bytes"
  validate_digest "$plugin_manifest $section.blob_sha256" "$blob_sha256"
  validate_count "$plugin_manifest $section.bytes" "$blob_bytes"
  expected_locator="registry://ghcr.io/$repository@sha256:$manifest_sha256"
  [ "$locator" = "$expected_locator" ] || fail "$plugin_manifest $section.locator must be $expected_locator"
  [[ "$cache_file" =~ ^${plugin_id}-[0-9a-f]{64}\.wasm$ ]] || fail "$plugin_manifest $section.cache_file is not a safe Moon cache name"
  [ "$(grep -Fxc "  plugin: \"$locator\"" "$moon_config")" = "1" ] ||
    fail "$moon_config must pin $plugin_id exactly once to $locator"
  plugin_records+=("$plugin_id|$repository|$manifest_sha256|$manifest_bytes|$blob_sha256|$blob_bytes|$cache_file")
done

for command_name in "${OLIPHAUNT_MOON_CURL:-curl}" mktemp node; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing required command: $command_name"
done

if [ -L "$cache_root" ]; then
  fail "toolchain cache root must not be a symbolic link: $cache_root"
fi
umask 077
mkdir -p "$cache_root"
[ -d "$cache_root" ] && [ ! -L "$cache_root" ] || fail "toolchain cache root is not a real directory: $cache_root"
archive_root="$cache_root/archives"
if [ -L "$archive_root" ]; then
  fail "toolchain archive cache must not be a symbolic link: $archive_root"
fi
mkdir -p "$archive_root"
[ -d "$archive_root" ] && [ ! -L "$archive_root" ] || fail "toolchain archive cache is not a real directory"

curl_tls_flag="$(oliphaunt_curl_platform_tls_flag)"
curl_common=(
  --fail --location --silent --show-error
  --proto '=https' --proto-redir '=https' --tlsv1.2
  --retry 5 --retry-all-errors --retry-connrefused --retry-delay 2 --retry-max-time 300
  --connect-timeout 20 --max-time 300 --speed-limit 1024 --speed-time 30
  --remove-on-error
)
if [ -n "$curl_tls_flag" ]; then
  curl_common+=("$curl_tls_flag")
fi

download_verified() {
  local url="$1"
  local expected_sha256="$2"
  local expected_bytes="$3"
  local output="$4"
  local expected_sha512="${5:-}"
  local bearer="${6:-}"
  local actual_size
  if [ -f "$output" ] && [ ! -L "$output" ]; then
    actual_size="$(wc -c <"$output" | tr -d '[:space:]')"
    if [ "$actual_size" = "$expected_bytes" ] &&
      [ "$(sha256_file "$output")" = "$expected_sha256" ] &&
      { [ -z "$expected_sha512" ] || [ "$(sha512_file "$output")" = "$expected_sha512" ]; }; then
      return 0
    fi
  fi
  rm -f "$output"
  local partial
  partial="$(mktemp "$archive_root/.download.XXXXXX")"
  local rc=0
  local args=("${curl_common[@]}" --max-filesize "$expected_bytes" --output "$partial")
  if [ -n "$bearer" ]; then
    args+=(--header "Authorization: Bearer $bearer")
  fi
  args+=("$url")
  if "${OLIPHAUNT_MOON_CURL:-curl}" "${args[@]}"; then
    :
  else
    rc=$?
    rm -f "$partial"
    return "$rc"
  fi
  actual_size="$(wc -c <"$partial" | tr -d '[:space:]')"
  [ "$actual_size" = "$expected_bytes" ] || {
    rm -f "$partial"
    fail "downloaded byte-size mismatch for $url: expected $expected_bytes, got $actual_size"
  }
  [ "$(sha256_file "$partial")" = "$expected_sha256" ] || {
    rm -f "$partial"
    fail "downloaded SHA-256 mismatch for $url"
  }
  if [ -n "$expected_sha512" ] && [ "$(sha512_file "$partial")" != "$expected_sha512" ]; then
    rm -f "$partial"
    fail "downloaded SHA-512 mismatch for $url"
  fi
  chmod 0444 "$partial"
  mv "$partial" "$output"
}

registry_token() {
  local repository="$1"
  local response
  response="$(mktemp "$archive_root/.token.XXXXXX")"
  local args=(
    "${curl_common[@]}"
    --max-filesize 16384
    --output "$response"
    "https://ghcr.io/token?scope=repository:$repository:pull"
  )
  if ! "${OLIPHAUNT_MOON_CURL:-curl}" "${args[@]}"; then
    rm -f "$response"
    fail "could not obtain a bounded read-only GHCR token for $repository"
  fi
  local token
  token="$($python - "$response" <<'PY'
import json
import pathlib
import sys

data = pathlib.Path(sys.argv[1]).read_bytes()
if len(data) > 16384:
    raise SystemExit(1)
value = json.loads(data).get("token")
if not isinstance(value, str):
    raise SystemExit(1)
print(value)
PY
  )" || {
    rm -f "$response"
    fail "GHCR returned an invalid token response for $repository"
  }
  rm -f "$response"
  [ "${#token}" -le 8192 ] && [[ "$token" =~ ^[-A-Za-z0-9._~+/=]+$ ]] ||
    fail "GHCR returned an unsafe token for $repository"
  printf '%s\n' "$token"
}

download_oci_manifest() {
  local repository="$1"
  local digest="$2"
  local expected_bytes="$3"
  local output="$4"
  local bearer="$5"
  if [ -f "$output" ] && [ ! -L "$output" ] &&
    [ "$(wc -c <"$output" | tr -d '[:space:]')" = "$expected_bytes" ] &&
    [ "$(sha256_file "$output")" = "$digest" ]; then
    return 0
  fi
  rm -f "$output"
  local partial headers
  partial="$(mktemp "$archive_root/.oci-manifest.XXXXXX")"
  headers="$(mktemp "$archive_root/.oci-headers.XXXXXX")"
  local args=(
    "${curl_common[@]}"
    --max-filesize "$expected_bytes"
    --header 'Accept: application/vnd.oci.image.manifest.v1+json'
    --header "Authorization: Bearer $bearer"
    --dump-header "$headers"
    --output "$partial"
    "https://ghcr.io/v2/$repository/manifests/sha256:$digest"
  )
  if ! "${OLIPHAUNT_MOON_CURL:-curl}" "${args[@]}"; then
    rm -f "$partial" "$headers"
    fail "could not fetch pinned OCI manifest $repository@sha256:$digest"
  fi
  grep -Eiq '^content-type:[[:space:]]*application/vnd[.]oci[.]image[.]manifest[.]v1[+]json[[:space:]]*\r?$' "$headers" || {
    rm -f "$partial" "$headers"
    fail "OCI manifest response for $repository had an unexpected content type"
  }
  grep -Eiq "^docker-content-digest:[[:space:]]*sha256:${digest}[[:space:]]*\r?$" "$headers" || {
    rm -f "$partial" "$headers"
    fail "OCI registry did not confirm the requested manifest digest for $repository"
  }
  rm -f "$headers"
  [ "$(wc -c <"$partial" | tr -d '[:space:]')" = "$expected_bytes" ] &&
    [ "$(sha256_file "$partial")" = "$digest" ] || {
      rm -f "$partial"
      fail "OCI manifest body integrity mismatch for $repository"
    }
  chmod 0444 "$partial"
  mv "$partial" "$output"
}

validate_oci_manifest() {
  local manifest_path="$1"
  local expected_blob_sha256="$2"
  local expected_blob_bytes="$3"
  "$python" - "$manifest_path" "$expected_blob_sha256" "$expected_blob_bytes" <<'PY'
import json
import pathlib
import sys

value = json.loads(pathlib.Path(sys.argv[1]).read_bytes())
expected_digest = f"sha256:{sys.argv[2]}"
expected_size = int(sys.argv[3])
if value.get("schemaVersion") != 2:
    raise SystemExit("OCI manifest schemaVersion must be 2")
if value.get("mediaType") != "application/vnd.oci.image.manifest.v1+json":
    raise SystemExit("OCI manifest has the wrong mediaType")
layers = value.get("layers")
if not isinstance(layers, list):
    raise SystemExit("OCI manifest layers must be an array")
wasm = [layer for layer in layers if isinstance(layer, dict) and layer.get("mediaType") == "application/wasm"]
if len(wasm) != 1 or wasm[0].get("digest") != expected_digest or wasm[0].get("size") != expected_size:
    raise SystemExit("OCI manifest does not bind exactly one expected WASM blob")
PY
}

identity="moon-$moon_version-pnpm-$pnpm_version"
install_parent="$cache_root/installations/$identity"
if [ -L "$cache_root/installations" ] || [ -L "$install_parent" ]; then
  fail "toolchain installation cache must not contain symbolic-link directories"
fi
mkdir -p "$install_parent"
final="$install_parent/$target"
moon_exe="$expected_moon_binary"
moonx_exe="$expected_moon_companion"

receipt_text="$(printf 'moon_version=%s\npnpm_version=%s\nproto_contract_version=%s\ntarget=%s\nmoon_archive_sha256=%s\npnpm_archive_sha256=%s\npnpm_tree_sha256=%s' \
  "$moon_version" \
  "$pnpm_version" \
  "$proto_version" \
  "$target" \
  "$moon_archive_sha256" \
  "$pnpm_archive_sha256" \
  "$pnpm_tree_sha256")"
pnpm_wrapper_text="$(printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"' \
  'exec node "$script_dir/../pnpm/bin/pnpm.mjs" "$@"')"
pnpx_wrapper_text="$(printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"' \
  'exec node "$script_dir/../pnpm/bin/pnpx.mjs" "$@"')"
pnpm_cmd_text="$(printf '%s\r\n' '@ECHO OFF' 'node "%~dp0..\pnpm\bin\pnpm.mjs" %*')"
pnpx_cmd_text="$(printf '%s\r\n' '@ECHO OFF' 'node "%~dp0..\pnpm\bin\pnpx.mjs" %*')"

moon_binary_version() {
  "$1" --version 2>/dev/null | awk '$1 == "moon" { print $2; exit }'
}

pnpm_binary_version() {
  node "$1" --version 2>/dev/null | awk 'NF { print $1; exit }'
}

cache_valid() {
  local candidate="$1"
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || return 1
  [ "$(find "$candidate" -mindepth 1 -maxdepth 1 | wc -l | tr -d '[:space:]')" = "4" ] || return 1
  [ -d "$candidate/bin" ] && [ ! -L "$candidate/bin" ] || return 1
  [ -d "$candidate/pnpm" ] && [ ! -L "$candidate/pnpm" ] || return 1
  [ -d "$candidate/plugins" ] && [ ! -L "$candidate/plugins" ] || return 1
  [ "$(find "$candidate/bin" -mindepth 1 -maxdepth 1 | wc -l | tr -d '[:space:]')" = "6" ] || return 1
  for path in \
    "$candidate/bin/$moon_exe" \
    "$candidate/bin/$moonx_exe" \
    "$candidate/pnpm/$pnpm_binary_path" \
    "$candidate/pnpm/$pnpm_companion_path" \
    "$candidate/pnpm/$pnpm_payload_path" \
    "$candidate/bin/pnpm" \
    "$candidate/bin/pnpx" \
    "$candidate/bin/pnpm.cmd" \
    "$candidate/bin/pnpx.cmd" \
    "$candidate/receipt"; do
    [ -f "$path" ] && [ ! -L "$path" ] || return 1
  done
  [ "$(sha256_file "$candidate/bin/$moon_exe")" = "$moon_binary_sha256" ] || return 1
  [ "$(sha256_file "$candidate/bin/$moonx_exe")" = "$moon_companion_sha256" ] || return 1
  [ "$(sha256_file "$candidate/pnpm/$pnpm_binary_path")" = "$pnpm_binary_sha256" ] || return 1
  [ "$(sha256_file "$candidate/pnpm/$pnpm_companion_path")" = "$pnpm_companion_sha256" ] || return 1
  [ "$(sha256_file "$candidate/pnpm/$pnpm_payload_path")" = "$pnpm_payload_sha256" ] || return 1
  [ "$(cat "$candidate/bin/pnpm")" = "$pnpm_wrapper_text" ] || return 1
  [ "$(cat "$candidate/bin/pnpx")" = "$pnpx_wrapper_text" ] || return 1
  [ "$(cat "$candidate/bin/pnpm.cmd")" = "$pnpm_cmd_text" ] || return 1
  [ "$(cat "$candidate/bin/pnpx.cmd")" = "$pnpx_cmd_text" ] || return 1
  if [ "$target" != "x86_64-pc-windows-msvc" ]; then
    [ -x "$candidate/bin/$moon_exe" ] && [ -x "$candidate/bin/$moonx_exe" ] || return 1
    [ -x "$candidate/bin/pnpm" ] && [ -x "$candidate/bin/pnpx" ] || return 1
  fi
  local tree_result
  local tree_args=(tree-digest --root "$candidate/pnpm")
  local executable
  for executable in "${pnpm_executables[@]}"; do
    tree_args+=(--executable "$executable")
  done
  tree_result="$($python "$extractor" "${tree_args[@]}" 2>/dev/null)" || return 1
  [ "$tree_result" = "$pnpm_file_count $pnpm_tree_sha256" ] || return 1
  [ "$(moon_binary_version "$candidate/bin/$moon_exe")" = "$moon_version" ] || return 1
  [ "$(pnpm_binary_version "$candidate/pnpm/$pnpm_binary_path")" = "$pnpm_version" ] || return 1
  [ "$(cat "$candidate/receipt")" = "$receipt_text" ] || return 1
  local plugin_count=0
  for record in "${plugin_records[@]}"; do
    IFS='|' read -r plugin_id repository manifest_sha256 manifest_bytes blob_sha256 blob_bytes cache_file <<<"$record"
    path="$candidate/plugins/$cache_file"
    [ -f "$path" ] && [ ! -L "$path" ] || return 1
    [ "$(wc -c <"$path" | tr -d '[:space:]')" = "$blob_bytes" ] || return 1
    [ "$(sha256_file "$path")" = "$blob_sha256" ] || return 1
    plugin_count=$((plugin_count + 1))
  done
  [ "$(find "$candidate/plugins" -mindepth 1 -maxdepth 1 | wc -l | tr -d '[:space:]')" = "$plugin_count" ] || return 1
}

if cache_valid "$final"; then
  printf '%s\n' "$final"
  exit 0
fi

moon_archive="$archive_root/$moon_archive_sha256.$moon_archive_suffix"
pnpm_archive="$archive_root/$pnpm_archive_sha256.tgz"
download_verified "$moon_url" "$moon_archive_sha256" "$moon_archive_bytes" "$moon_archive"
download_verified "$pnpm_url" "$pnpm_archive_sha256" "$pnpm_archive_bytes" "$pnpm_archive" "$pnpm_archive_sha512"

for record in "${plugin_records[@]}"; do
  IFS='|' read -r plugin_id repository manifest_sha256 manifest_bytes blob_sha256 blob_bytes cache_file <<<"$record"
  oci_manifest="$archive_root/$manifest_sha256.oci.json"
  blob="$archive_root/$blob_sha256.wasm"
  token=""
  if ! { [ -f "$oci_manifest" ] && [ ! -L "$oci_manifest" ] && [ "$(wc -c <"$oci_manifest" | tr -d '[:space:]')" = "$manifest_bytes" ] && [ "$(sha256_file "$oci_manifest")" = "$manifest_sha256" ]; }; then
    token="$(registry_token "$repository")"
    download_oci_manifest "$repository" "$manifest_sha256" "$manifest_bytes" "$oci_manifest" "$token"
  fi
  validate_oci_manifest "$oci_manifest" "$blob_sha256" "$blob_bytes" ||
    fail "pinned OCI manifest does not bind the expected $plugin_id WASM blob"
  if ! { [ -f "$blob" ] && [ ! -L "$blob" ] && [ "$(wc -c <"$blob" | tr -d '[:space:]')" = "$blob_bytes" ] && [ "$(sha256_file "$blob")" = "$blob_sha256" ]; }; then
    if [ -z "$token" ]; then
      token="$(registry_token "$repository")"
    fi
    download_verified \
      "https://ghcr.io/v2/$repository/blobs/sha256:$blob_sha256" \
      "$blob_sha256" \
      "$blob_bytes" \
      "$blob" \
      "" \
      "$token"
  fi
done

stage="$(mktemp -d "$install_parent/.$target.stage.XXXXXX")"
backup=""
old_moved=0
cleanup() {
  local rc="$?"
  trap - EXIT HUP INT TERM
  if [ -n "$stage" ]; then
    rm -rf "$stage"
  fi
  if [ "$old_moved" = "1" ] && [ -n "$backup" ] && [ -e "$backup" ] && [ ! -e "$final" ]; then
    mv "$backup" "$final" || rc=1
  elif [ -n "$backup" ]; then
    rm -rf "$backup"
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

moon_extract="$stage/moon-extract"
pnpm_extract="$stage/pnpm"
moon_extract_args=(
  extract \
  --archive "$moon_archive" \
  --format "$moon_format" \
  --prefix "$moon_prefix" \
  --entry-count "$moon_entry_count" \
  --expected-bytes "$moon_archive_bytes" \
  --expanded-bytes "$moon_expanded_bytes" \
  --destination "$moon_extract" \
  --required "$moon_binary_path" \
  --required "$moon_companion_path"
)
for executable in "${moon_archive_executables[@]}"; do
  moon_extract_args+=(--executable "$executable")
done
"$python" "$extractor" "${moon_extract_args[@]}"
pnpm_extract_args=(
  extract
  --archive "$pnpm_archive" \
  --format "$pnpm_format" \
  --prefix "$pnpm_prefix" \
  --entry-count "$pnpm_entry_count" \
  --expected-bytes "$pnpm_archive_bytes" \
  --expanded-bytes "$pnpm_expanded_bytes" \
  --destination "$pnpm_extract" \
  --required "$pnpm_binary_path" \
  --required "$pnpm_companion_path" \
  --required "$pnpm_payload_path" \
  --required package.json
)
for executable in "${pnpm_executables[@]}"; do
  pnpm_extract_args+=(--required "$executable" --executable "$executable")
done
"$python" "$extractor" "${pnpm_extract_args[@]}"

mkdir -p "$stage/bin" "$stage/plugins"
mv "$moon_extract/$moon_binary_path" "$stage/bin/$moon_exe"
mv "$moon_extract/$moon_companion_path" "$stage/bin/$moonx_exe"
rm -rf "$moon_extract"
chmod 0555 "$stage/bin/$moon_exe" "$stage/bin/$moonx_exe"

printf '%s\n' "$pnpm_wrapper_text" >"$stage/bin/pnpm"
printf '%s\n' "$pnpx_wrapper_text" >"$stage/bin/pnpx"
printf '%s\n' "$pnpm_cmd_text" >"$stage/bin/pnpm.cmd"
printf '%s\n' "$pnpx_cmd_text" >"$stage/bin/pnpx.cmd"
chmod 0555 "$stage/bin/pnpm" "$stage/bin/pnpx"
chmod 0444 "$stage/bin/pnpm.cmd" "$stage/bin/pnpx.cmd"

for record in "${plugin_records[@]}"; do
  IFS='|' read -r plugin_id repository manifest_sha256 manifest_bytes blob_sha256 blob_bytes cache_file <<<"$record"
  cp "$archive_root/$blob_sha256.wasm" "$stage/plugins/$cache_file"
  chmod 0444 "$stage/plugins/$cache_file"
done
printf '%s\n' "$receipt_text" >"$stage/receipt"
chmod 0444 "$stage/receipt"

cache_valid "$stage" || fail "staged Moon toolchain failed integrity or version validation"

if [ -e "$final" ] || [ -L "$final" ]; then
  backup="$(mktemp -d "$install_parent/.$target.backup.XXXXXX")"
  rmdir "$backup"
  mv "$final" "$backup"
  old_moved=1
fi
if [ "${OLIPHAUNT_MOON_TOOLCHAIN_TEST_INTERRUPT_AFTER_BACKUP:-0}" = "1" ]; then
  [ "${OLIPHAUNT_MOON_TOOLCHAIN_TESTING:-0}" = "1" ] ||
    fail "OLIPHAUNT_MOON_TOOLCHAIN_TEST_INTERRUPT_AFTER_BACKUP is test-only"
  kill -TERM "$$"
fi
mv "$stage" "$final"
stage=""
if [ "$old_moved" = "1" ]; then
  rm -rf "$backup"
  backup=""
  old_moved=0
fi
printf '%s\n' "$final"

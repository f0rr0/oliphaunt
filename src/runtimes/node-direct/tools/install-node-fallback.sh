#!/usr/bin/env sh
set -eu

die() {
  echo "Node fallback install failed: $*" >&2
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

root="${OLIPHAUNT_NODE_FALLBACK_ROOT:-}"
if [ -z "$root" ]; then
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || die "must run inside the Oliphaunt git checkout"
fi
manifest="${OLIPHAUNT_NODE_FALLBACK_MANIFEST:-$root/src/sources/toolchains/node.toml}"
extractor="${OLIPHAUNT_NODE_HEADERS_EXTRACTOR:-$root/src/runtimes/node-direct/tools/extract-node-headers.mjs}"
curl_platform_flags="$root/tools/dev/curl-platform-flags.sh"
cache_root="${OLIPHAUNT_NODE_FALLBACK_CACHE_ROOT:-$root/target/oliphaunt-node-direct}"

[ -f "$manifest" ] || die "missing Node toolchain manifest: $manifest"
[ -f "$extractor" ] || die "missing Node headers extractor: $extractor"
if [ ! -f "$curl_platform_flags" ] || [ -L "$curl_platform_flags" ]; then
  die "missing regular curl platform policy: $curl_platform_flags"
fi
# shellcheck source=tools/dev/curl-platform-flags.sh
. "$curl_platform_flags"

manifest_values="$({
  awk '
    function reject(message) {
      print "invalid Node toolchain manifest at line " NR ": " message > "/dev/stderr"
      invalid = 1
      exit 1
    }
    function quoted_value(line, value) {
      value = line
      sub(/^[^=]*=[[:space:]]*"/, "", value)
      sub(/"[[:space:]]*$/, "", value)
      return value
    }
    {
      sub(/\r$/, "")
      line = $0
      trimmed = line
      sub(/^[[:space:]]+/, "", trimmed)
      sub(/[[:space:]]+$/, "", trimmed)
      if (trimmed == "" || trimmed ~ /^#/) next
      if (trimmed ~ /^\[/) {
        if (trimmed != "[toolchain]" && trimmed != "[headers]" && trimmed != "[windows.x64]") {
          reject("unexpected section " trimmed)
        }
        section = trimmed
        sections[section]++
        if (sections[section] != 1) reject("duplicate section " section)
        next
      }
      if (section == "[toolchain]" && trimmed ~ /^version[[:space:]]*=[[:space:]]*"[^"]+"[[:space:]]*$/) {
        counts["version"]++
        values["version"] = quoted_value(trimmed)
        next
      }
      if (section == "[headers]" && trimmed ~ /^url[[:space:]]*=[[:space:]]*"[^"]+"[[:space:]]*$/) {
        counts["headers_url"]++
        values["headers_url"] = quoted_value(trimmed)
        next
      }
      if (section == "[headers]" && trimmed ~ /^sha256[[:space:]]*=[[:space:]]*"[^"]+"[[:space:]]*$/) {
        counts["headers_sha"]++
        values["headers_sha"] = quoted_value(trimmed)
        next
      }
      if (section == "[windows.x64]" && trimmed ~ /^url[[:space:]]*=[[:space:]]*"[^"]+"[[:space:]]*$/) {
        counts["windows_url"]++
        values["windows_url"] = quoted_value(trimmed)
        next
      }
      if (section == "[windows.x64]" && trimmed ~ /^sha256[[:space:]]*=[[:space:]]*"[^"]+"[[:space:]]*$/) {
        counts["windows_sha"]++
        values["windows_sha"] = quoted_value(trimmed)
        next
      }
      reject("unexpected or non-quoted assignment")
    }
    END {
      if (invalid) exit 1
      if (sections["[toolchain]"] != 1 || sections["[headers]"] != 1 || sections["[windows.x64]"] != 1) {
        print "invalid Node toolchain manifest: every required section must occur exactly once" > "/dev/stderr"
        exit 1
      }
      if (counts["version"] != 1 || counts["headers_url"] != 1 || counts["headers_sha"] != 1 ||
          counts["windows_url"] != 1 || counts["windows_sha"] != 1) {
        print "invalid Node toolchain manifest: every required value must occur exactly once" > "/dev/stderr"
        exit 1
      }
      print values["version"]
      print values["headers_url"]
      print values["headers_sha"]
      print values["windows_url"]
      print values["windows_sha"]
    }
  ' "$manifest"
})" || die "could not parse $manifest"

manifest_value() {
  printf '%s\n' "$manifest_values" | sed -n "$1"p
}

node_version="$(manifest_value 1)"
headers_url="$(manifest_value 2)"
headers_sha256="$(manifest_value 3)"
windows_x64_url="$(manifest_value 4)"
windows_x64_sha256="$(manifest_value 5)"

case "$node_version" in
  ''|.*|*.|*..*|*[!0-9.]*) die "manifest Node version must have numeric major.minor.patch form" ;;
esac
[ "$(printf '%s\n' "$node_version" | awk -F. 'NF == 3 && $1 != "" && $2 != "" && $3 != "" { print "valid" }')" = "valid" ] ||
  die "manifest Node version must have numeric major.minor.patch form"

validate_sha256() {
  value="$1"
  label="$2"
  [ "${#value}" -eq 64 ] || die "$label must contain exactly 64 hexadecimal characters"
  case "$value" in
    *[!0-9a-f]*) die "$label must contain exactly 64 lowercase hexadecimal characters" ;;
  esac
}

validate_sha256 "$headers_sha256" "headers sha256"
validate_sha256 "$windows_x64_sha256" "Windows x64 node.lib sha256"

expected_headers_url="https://nodejs.org/download/release/v$node_version/node-v$node_version-headers.tar.gz"
expected_windows_x64_url="https://nodejs.org/download/release/v$node_version/win-x64/node.lib"
[ "$headers_url" = "$expected_headers_url" ] || die "headers URL must be $expected_headers_url"
[ "$windows_x64_url" = "$expected_windows_x64_url" ] || die "Windows x64 node.lib URL must be $expected_windows_x64_url"

operation="${1:-}"
case "$operation" in
  headers)
    [ "$#" -eq 1 ] || die "usage: install-node-fallback.sh headers"
    ;;
  windows-lib)
    [ "$#" -eq 2 ] || die "usage: install-node-fallback.sh windows-lib x64"
    [ "$2" = "x64" ] || die "only the pinned Windows x64 node.lib fallback is supported"
    ;;
  *) die "usage: install-node-fallback.sh <headers|windows-lib> [x64]" ;;
esac
require node
runtime_version="$(node -p 'process.versions.node')" || die "could not read the active Node runtime version"
[ "$runtime_version" = "$node_version" ] ||
  die "fallback requires Node $node_version, but the active runtime is Node ${runtime_version:-<empty>}"

if command -v sha256sum >/dev/null 2>&1; then
  sha256_file() {
    sha256sum "$1" | awk '{print $1}'
  }
elif command -v shasum >/dev/null 2>&1; then
  sha256_file() {
    shasum -a 256 "$1" | awk '{print $1}'
  }
else
  die "missing required command: sha256sum or shasum"
fi

partial=''
stage=''
backup=''
final=''
old_moved=0

cleanup() {
  status=$?
  trap - 0 1 2 15
  [ -z "$partial" ] || rm -f "$partial"
  [ -z "$stage" ] || rm -rf "$stage"
  if [ "$old_moved" -eq 1 ] && [ -n "$backup" ] && [ -e "$backup" ]; then
    if [ -n "$final" ] && [ ! -e "$final" ]; then
      if ! mv "$backup" "$final"; then
        echo "Node fallback install failed: could not restore cache from $backup" >&2
        status=1
      fi
    else
      rm -rf "$backup"
    fi
  elif [ -n "$backup" ]; then
    rm -rf "$backup"
  fi
  exit "$status"
}
trap cleanup 0
trap 'exit 129' 1
trap 'exit 130' 2
trap 'exit 143' 15

download() {
  url="$1"
  output="$2"
  max_bytes="$3"
  curl_command="${OLIPHAUNT_NODE_FALLBACK_CURL:-curl}"
  require "$curl_command"
  curl_platform_tls_flag="$(oliphaunt_curl_platform_tls_flag)"
  # The expansion is either absent or the single literal emitted by the
  # repository-owned platform policy.
  # shellcheck disable=SC2086
  "$curl_command" \
    --fail \
    --location \
    --silent \
    --show-error \
    --proto '=https' \
    --proto-redir '=https' \
    --retry 5 \
    --retry-all-errors \
    --retry-delay 2 \
    --retry-max-time 120 \
    --connect-timeout 20 \
    --max-time 180 \
    --max-filesize "$max_bytes" \
    ${curl_platform_tls_flag:+"$curl_platform_tls_flag"} \
    --remove-on-error \
    --output "$output" \
    "$url"
}

headers_cache_valid() {
  candidate="$1"
  marker="$candidate/.oliphaunt-source.sha256"
  [ -d "$candidate/include/node" ] && [ ! -L "$candidate/include/node" ] || return 1
  for required_header in node_api.h node.h v8.h; do
    required_path="$candidate/include/node/$required_header"
    [ -f "$required_path" ] && [ ! -L "$required_path" ] && [ -s "$required_path" ] || return 1
  done
  [ -f "$marker" ] && [ ! -L "$marker" ] || return 1
  [ "$(awk 'END { print NR }' "$marker")" = "2" ] || return 1
  marker_contents="$(cat "$marker")" || return 1
  expected_marker="$(printf 'version=%s\narchive_sha256=%s\n' "$node_version" "$headers_sha256")"
  [ "$marker_contents" = "$expected_marker" ] || return 1
}

install_headers() {
  parent="$cache_root/node-headers"
  final="$parent/v$node_version"
  if headers_cache_valid "$final"; then
    printf '%s\n' "$final/include/node"
    return
  fi

  require mktemp
  mkdir -p "$parent"
  partial="$(mktemp "$parent/.node-v$node_version-headers.partial.XXXXXX")"
  stage="$(mktemp -d "$parent/.node-v$node_version-headers.stage.XXXXXX")"
  download "$headers_url" "$partial" 67108864
  actual_sha256="$(sha256_file "$partial")"
  [ "$actual_sha256" = "$headers_sha256" ] ||
    die "Node headers checksum mismatch: expected $headers_sha256, received $actual_sha256"
  node "$extractor" "$partial" "$stage" "node-v$node_version"
  printf 'version=%s\narchive_sha256=%s\n' "$node_version" "$headers_sha256" >"$stage/.oliphaunt-source.sha256"
  headers_cache_valid "$stage" || die "staged Node headers cache failed validation"

  if [ -e "$final" ] || [ -L "$final" ]; then
    backup="$(mktemp -d "$parent/.node-v$node_version-headers.backup.XXXXXX")"
    rmdir "$backup"
    mv "$final" "$backup"
    old_moved=1
  fi
  mv "$stage" "$final"
  stage=''
  if [ "$old_moved" -eq 1 ]; then
    rm -rf "$backup"
    backup=''
    old_moved=0
  fi
  rm -f "$partial"
  partial=''
  printf '%s\n' "$final/include/node"
}

install_windows_lib() {
  parent="$cache_root/node-lib/v$node_version-win-x64"
  final="$parent/node.lib"
  mkdir -p "$parent"
  if [ -f "$final" ] && [ ! -L "$final" ]; then
    actual_sha256="$(sha256_file "$final")"
    if [ "$actual_sha256" = "$windows_x64_sha256" ]; then
      printf '%s\n' "$final"
      return
    fi
  fi
  if [ -e "$final" ] || [ -L "$final" ]; then
    rm -rf "$final"
  fi

  require mktemp
  partial="$(mktemp "$parent/.node.lib.partial.XXXXXX")"
  download "$windows_x64_url" "$partial" 134217728
  actual_sha256="$(sha256_file "$partial")"
  [ "$actual_sha256" = "$windows_x64_sha256" ] ||
    die "Windows x64 node.lib checksum mismatch: expected $windows_x64_sha256, received $actual_sha256"
  [ -s "$partial" ] || die "downloaded Windows x64 node.lib is empty"
  mv "$partial" "$final"
  partial=''
  printf '%s\n' "$final"
}

case "$operation" in
  headers) install_headers ;;
  windows-lib) install_windows_lib ;;
esac

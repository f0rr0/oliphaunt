#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "install-pinned-node.sh: $*" >&2
  exit 1
}

root="${OLIPHAUNT_NODE_RUNTIME_ROOT:-}"
if [ -z "$root" ]; then
  root="$(git rev-parse --show-toplevel 2>/dev/null)" ||
    fail "must run inside the Oliphaunt checkout"
fi

action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
manifest="${OLIPHAUNT_NODE_RUNTIME_MANIFEST:-$root/src/sources/toolchains/node-runtime.toml}"
proto_file="${OLIPHAUNT_NODE_RUNTIME_PROTO_FILE:-$root/.prototools}"
extractor="${OLIPHAUNT_NODE_RUNTIME_ARCHIVE_EXTRACTOR:-$action_dir/toolchain-archive.py}"
curl_platform_flags="$root/tools/dev/curl-platform-flags.sh"
cache_root="${OLIPHAUNT_NODE_RUNTIME_CACHE_ROOT:-${RUNNER_TEMP:-$root/target}/oliphaunt-node-runtime}"

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    if command -v cygpath >/dev/null 2>&1; then
      cache_root="$(cygpath -u "$cache_root")"
    fi
    ;;
esac

for path in "$manifest" "$proto_file" "$extractor" "$curl_platform_flags"; do
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
  local section="$1"
  local key="$2"
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
    END { if (count != 1 || value == "") exit 1; print value }
  ' "$manifest"
}

proto_version() {
  awk -F '=' '
    $1 ~ "^[[:space:]]*node[[:space:]]*$" {
      count++
      value=$2
      gsub(/^[[:space:]"]+|[[:space:]"]+$/, "", value)
    }
    END { if (count != 1 || value == "") exit 1; print value }
  ' "$proto_file"
}

validate_digest() {
  local label="$1"
  local digest="$2"
  [ "${#digest}" -eq 64 ] && [[ ! "$digest" =~ [^0-9a-f] ]] ||
    fail "$label must contain exactly 64 lowercase hexadecimal characters"
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

node_version="$(manifest_value toolchain version)" ||
  fail "$manifest must contain exactly one quoted toolchain.version"
[[ "$node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "invalid Node.js version: $node_version"
configured="$(proto_version)" || fail "$proto_file must contain exactly one node version"
configured="${configured#v}"
[ "$configured" = "$node_version" ] ||
  fail "$proto_file node version $configured does not match pinned version $node_version"

if [ -n "${OLIPHAUNT_NODE_RUNTIME_TARGET:-}" ]; then
  [ "${OLIPHAUNT_NODE_RUNTIME_TESTING:-0}" = "1" ] ||
    fail "OLIPHAUNT_NODE_RUNTIME_TARGET is test-only"
  target="$OLIPHAUNT_NODE_RUNTIME_TARGET"
else
  case "$(uname -s):$(uname -m)" in
    Darwin:arm64 | Darwin:aarch64) target="aarch64-apple-darwin" ;;
    Darwin:x86_64) target="x86_64-apple-darwin" ;;
    Linux:arm64 | Linux:aarch64) target="aarch64-unknown-linux-gnu" ;;
    Linux:x86_64) target="x86_64-unknown-linux-gnu" ;;
    MINGW*:x86_64 | MSYS*:x86_64 | CYGWIN*:x86_64 | MINGW*:AMD64 | MSYS*:AMD64 | CYGWIN*:AMD64)
      target="x86_64-pc-windows-msvc"
      ;;
    *) fail "unsupported Node.js host: $(uname -s)-$(uname -m)" ;;
  esac
fi

section="assets.$target"
url="$(manifest_value "$section" url)" || fail "$manifest is missing $section.url"
archive_sha256="$(manifest_value "$section" sha256)" || fail "$manifest is missing $section.sha256"
archive_bytes="$(manifest_value "$section" bytes)" || fail "$manifest is missing $section.bytes"
archive_format="$(manifest_value "$section" format)" || fail "$manifest is missing $section.format"
binary_path="$(manifest_value "$section" binary_path)" || fail "$manifest is missing $section.binary_path"
binary_sha256="$(manifest_value "$section" binary_sha256)" || fail "$manifest is missing $section.binary_sha256"
binary_bytes="$(manifest_value "$section" binary_bytes)" || fail "$manifest is missing $section.binary_bytes"

case "$target" in
  aarch64-apple-darwin) archive_name="node-v$node_version-darwin-arm64.tar.gz"; expected_format="tar.gz"; expected_binary="node-v$node_version-darwin-arm64/bin/node"; binary_name="node" ;;
  x86_64-apple-darwin) archive_name="node-v$node_version-darwin-x64.tar.gz"; expected_format="tar.gz"; expected_binary="node-v$node_version-darwin-x64/bin/node"; binary_name="node" ;;
  aarch64-unknown-linux-gnu) archive_name="node-v$node_version-linux-arm64.tar.xz"; expected_format="tar.xz"; expected_binary="node-v$node_version-linux-arm64/bin/node"; binary_name="node" ;;
  x86_64-unknown-linux-gnu) archive_name="node-v$node_version-linux-x64.tar.xz"; expected_format="tar.xz"; expected_binary="node-v$node_version-linux-x64/bin/node"; binary_name="node" ;;
  x86_64-pc-windows-msvc) archive_name="node-v$node_version-win-x64.zip"; expected_format="zip"; expected_binary="node-v$node_version-win-x64/node.exe"; binary_name="node.exe" ;;
  *) fail "unsupported pinned Node.js target: $target" ;;
esac
expected_url="https://nodejs.org/download/release/v$node_version/$archive_name"
[ "$url" = "$expected_url" ] || fail "$manifest $section.url must be $expected_url"
[ "$archive_format" = "$expected_format" ] || fail "$manifest $section.format must be $expected_format"
[ "$binary_path" = "$expected_binary" ] || fail "$manifest $section.binary_path must be $expected_binary"
validate_digest "$manifest $section.sha256" "$archive_sha256"
validate_digest "$manifest $section.binary_sha256" "$binary_sha256"
validate_count "$manifest $section.bytes" "$archive_bytes"
validate_count "$manifest $section.binary_bytes" "$binary_bytes"

curl_command="${OLIPHAUNT_NODE_CURL:-curl}"
command -v "$curl_command" >/dev/null 2>&1 || fail "missing required command: $curl_command"
command -v mktemp >/dev/null 2>&1 || fail "missing required command: mktemp"

if [ -L "$cache_root" ]; then
  fail "Node.js cache root must not be a symbolic link: $cache_root"
fi
umask 077
mkdir -p "$cache_root"
[ -d "$cache_root" ] && [ ! -L "$cache_root" ] || fail "Node.js cache root is not a real directory"
archive_root="$cache_root/archives"
install_parent="$cache_root/installations/node-$node_version"
for directory in "$archive_root" "$cache_root/installations" "$install_parent"; do
  [ ! -L "$directory" ] || fail "Node.js cache must not contain symbolic-link directories"
  mkdir -p "$directory"
  [ -d "$directory" ] && [ ! -L "$directory" ] || fail "Node.js cache directory is not real: $directory"
done

final="$install_parent/$target"
binary="$final/bin/$binary_name"
receipt_text="$(printf 'node_version=%s\ntarget=%s\narchive_sha256=%s\nbinary_sha256=%s\nbinary_bytes=%s' \
  "$node_version" "$target" "$archive_sha256" "$binary_sha256" "$binary_bytes")"

binary_version() {
  "$1" --version 2>/dev/null | awk 'NF { print $1; exit }'
}

cache_valid() {
  local candidate="$1"
  local candidate_binary="$candidate/bin/$binary_name"
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || return 1
  [ "$(find "$candidate" -mindepth 1 -maxdepth 1 | wc -l | tr -d '[:space:]')" = "2" ] || return 1
  [ -d "$candidate/bin" ] && [ ! -L "$candidate/bin" ] || return 1
  [ "$(find "$candidate/bin" -mindepth 1 -maxdepth 1 | wc -l | tr -d '[:space:]')" = "1" ] || return 1
  [ -f "$candidate_binary" ] && [ ! -L "$candidate_binary" ] || return 1
  [ -f "$candidate/receipt" ] && [ ! -L "$candidate/receipt" ] || return 1
  [ "$(wc -c <"$candidate_binary" | tr -d '[:space:]')" = "$binary_bytes" ] || return 1
  [ "$(sha256_file "$candidate_binary")" = "$binary_sha256" ] || return 1
  case "$target" in
    x86_64-pc-windows-msvc) ;;
    *) [ -x "$candidate_binary" ] || return 1 ;;
  esac
  [ "$(binary_version "$candidate_binary")" = "v$node_version" ] || return 1
  [ "$(cat "$candidate/receipt")" = "$receipt_text" ] || return 1
}

if cache_valid "$final"; then
  printf '%s\n' "$binary"
  exit 0
fi

archive="$archive_root/$archive_sha256.$archive_format"
archive_valid=0
if [ -f "$archive" ] && [ ! -L "$archive" ] &&
  [ "$(wc -c <"$archive" | tr -d '[:space:]')" = "$archive_bytes" ] &&
  [ "$(sha256_file "$archive")" = "$archive_sha256" ]; then
  archive_valid=1
fi
if [ "$archive_valid" != "1" ]; then
  rm -f "$archive"
  partial="$(mktemp "$archive_root/.download.XXXXXX")"
  curl_tls_flag="$(oliphaunt_curl_platform_tls_flag)"
  curl_args=(
    --fail --location --silent --show-error
    --proto '=https' --proto-redir '=https' --tlsv1.2
    --retry 5 --retry-all-errors --retry-connrefused --retry-delay 2 --retry-max-time 300
    --connect-timeout 20 --max-time 300 --speed-limit 1024 --speed-time 30
    --remove-on-error --max-filesize "$archive_bytes" --output "$partial"
  )
  if [ -n "$curl_tls_flag" ]; then
    curl_args+=("$curl_tls_flag")
  fi
  curl_args+=("$url")
  if ! "$curl_command" "${curl_args[@]}"; then
    rm -f "$partial"
    fail "could not download pinned Node.js archive $url"
  fi
  [ "$(wc -c <"$partial" | tr -d '[:space:]')" = "$archive_bytes" ] &&
    [ "$(sha256_file "$partial")" = "$archive_sha256" ] || {
      rm -f "$partial"
      fail "downloaded Node.js archive integrity mismatch for $url"
    }
  chmod 0444 "$partial"
  mv "$partial" "$archive"
fi

stage="$(mktemp -d "$install_parent/.$target.stage.XXXXXX")"
backup=""
old_moved=0
cleanup() {
  local rc="$?"
  trap - EXIT HUP INT TERM
  rm -rf "$stage"
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

mkdir -p "$stage/bin"
"$python" "$extractor" extract-file \
  --archive "$archive" \
  --format "$archive_format" \
  --expected-bytes "$archive_bytes" \
  --member "$binary_path" \
  --member-bytes "$binary_bytes" \
  --member-sha256 "$binary_sha256" \
  --destination "$stage/bin/$binary_name" \
  --executable
chmod 0555 "$stage/bin/$binary_name"
printf '%s\n' "$receipt_text" >"$stage/receipt"
chmod 0444 "$stage/receipt"
cache_valid "$stage" || fail "staged Node.js runtime failed integrity or version validation"

if [ -e "$final" ] || [ -L "$final" ]; then
  backup="$(mktemp -d "$install_parent/.$target.backup.XXXXXX")"
  rmdir "$backup"
  mv "$final" "$backup"
  old_moved=1
fi
if [ "${OLIPHAUNT_NODE_RUNTIME_TEST_INTERRUPT_AFTER_BACKUP:-0}" = "1" ]; then
  [ "${OLIPHAUNT_NODE_RUNTIME_TESTING:-0}" = "1" ] ||
    fail "OLIPHAUNT_NODE_RUNTIME_TEST_INTERRUPT_AFTER_BACKUP is test-only"
  kill -TERM "$$"
fi
mv "$stage" "$final"
stage=""
if [ "$old_moved" = "1" ]; then
  rm -rf "$backup"
  backup=""
  old_moved=0
fi
printf '%s\n' "$binary"

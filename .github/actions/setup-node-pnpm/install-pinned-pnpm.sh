#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "install-pinned-pnpm.sh: $*" >&2
  exit 1
}

root="$(git rev-parse --show-toplevel 2>/dev/null)" ||
  fail "must run inside the Oliphaunt checkout"
manifest="${OLIPHAUNT_PNPM_MANIFEST:-$root/src/sources/toolchains/pnpm.toml}"
proto_file="${OLIPHAUNT_PNPM_PROTO_FILE:-$root/.prototools}"
extractor="${OLIPHAUNT_PNPM_ARCHIVE_EXTRACTOR:-$root/.github/actions/setup-moon/toolchain-archive.py}"
curl_platform_flags="${OLIPHAUNT_PNPM_CURL_PLATFORM_FLAGS:-$root/tools/dev/curl-platform-flags.sh}"
cache_root="${OLIPHAUNT_PNPM_CACHE_ROOT:-${RUNNER_TEMP:-$root/target}/oliphaunt-pnpm-runtime}"
curl_command="${OLIPHAUNT_PNPM_CURL:-curl}"
testing="${OLIPHAUNT_PNPM_TESTING:-0}"

for override in \
  OLIPHAUNT_PNPM_MANIFEST \
  OLIPHAUNT_PNPM_PROTO_FILE \
  OLIPHAUNT_PNPM_ARCHIVE_EXTRACTOR \
  OLIPHAUNT_PNPM_CURL_PLATFORM_FLAGS \
  OLIPHAUNT_PNPM_CURL; do
  if [ -n "${!override:-}" ] && [ "$testing" != "1" ]; then
    fail "$override is test-only"
  fi
done

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    if command -v cygpath >/dev/null 2>&1; then
      cache_root="$(cygpath -u "$cache_root")"
    fi
    ;;
esac

for path in "$manifest" "$proto_file" "$extractor" "$curl_platform_flags"; do
  if [ ! -f "$path" ] || [ -L "$path" ]; then
    fail "missing regular bootstrap input: $path"
  fi
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
for command_name in "$curl_command" mktemp node; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing required command: $command_name"
done

manifest_value() {
  local source="$1"
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
  ' "$source"
}

prototool_version() {
  awk -F '=' '
    $1 ~ "^[[:space:]]*pnpm[[:space:]]*$" {
      count++
      value=$2
      gsub(/^[[:space:]"]+|[[:space:]"]+$/, "", value)
    }
    END { if (count != 1 || value == "") exit 1; print value }
  ' "$proto_file"
}

validate_version() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "invalid pnpm version: $1"
}

validate_sha256() {
  if [ "${#1}" -ne 64 ] || [[ "$1" =~ [^0-9a-f] ]]; then
    fail "$2 must contain exactly 64 lowercase hexadecimal characters"
  fi
}

validate_sha512() {
  if [ "${#1}" -ne 128 ] || [[ "$1" =~ [^0-9a-f] ]]; then
    fail "$2 must contain exactly 128 lowercase hexadecimal characters"
  fi
}

validate_count() {
  case "$1" in
    '' | *[!0-9]*) fail "$2 must be a positive integer" ;;
  esac
  [ "$1" -gt 0 ] || fail "$2 must be a positive integer"
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

version="$(manifest_value "$manifest" toolchain version)" ||
  fail "$manifest must contain exactly one quoted toolchain.version"
url="$(manifest_value "$manifest" package url)" || fail "$manifest is missing package.url"
archive_sha256="$(manifest_value "$manifest" package sha256)" || fail "$manifest is missing package.sha256"
archive_sha512="$(manifest_value "$manifest" package sha512)" || fail "$manifest is missing package.sha512"
archive_bytes="$(manifest_value "$manifest" package bytes)" || fail "$manifest is missing package.bytes"
expanded_bytes="$(manifest_value "$manifest" package expanded_bytes)" || fail "$manifest is missing package.expanded_bytes"
format="$(manifest_value "$manifest" package format)" || fail "$manifest is missing package.format"
prefix="$(manifest_value "$manifest" package prefix)" || fail "$manifest is missing package.prefix"
entry_count="$(manifest_value "$manifest" package entry_count)" || fail "$manifest is missing package.entry_count"
file_count="$(manifest_value "$manifest" package file_count)" || fail "$manifest is missing package.file_count"
tree_sha256="$(manifest_value "$manifest" package tree_sha256)" || fail "$manifest is missing package.tree_sha256"
executable_paths="$(manifest_value "$manifest" package executable_paths)" || fail "$manifest is missing package.executable_paths"
binary_path="$(manifest_value "$manifest" package binary_path)" || fail "$manifest is missing package.binary_path"
binary_sha256="$(manifest_value "$manifest" package binary_sha256)" || fail "$manifest is missing package.binary_sha256"
companion_path="$(manifest_value "$manifest" package companion_path)" || fail "$manifest is missing package.companion_path"
companion_sha256="$(manifest_value "$manifest" package companion_sha256)" || fail "$manifest is missing package.companion_sha256"
payload_path="$(manifest_value "$manifest" package payload_path)" || fail "$manifest is missing package.payload_path"
payload_sha256="$(manifest_value "$manifest" package payload_sha256)" || fail "$manifest is missing package.payload_sha256"

validate_version "$version"
configured="$(prototool_version)" || fail "$proto_file must contain exactly one pnpm version"
configured="${configured#v}"
[ "$configured" = "$version" ] ||
  fail "$proto_file pnpm version $configured does not match pinned version $version"
if [ -n "${EXPECTED_PNPM_VERSION:-}" ]; then
  validate_version "$EXPECTED_PNPM_VERSION"
  [ "$EXPECTED_PNPM_VERSION" = "$version" ] ||
    fail "requested pnpm $EXPECTED_PNPM_VERSION does not match pinned version $version"
fi

expected_url="https://registry.npmjs.org/pnpm/-/pnpm-$version.tgz"
expected_executable_paths="bin/pnpm.mjs,bin/pnpx.mjs,dist/node-gyp-bin/node-gyp,dist/node-gyp-bin/node-gyp.cmd,dist/node_modules/node-gyp/bin/node-gyp.js"
[ "$url" = "$expected_url" ] || fail "$manifest package.url must be $expected_url"
[ "$format" = "tar.gz" ] || fail "$manifest package.format must be tar.gz"
[ "$prefix" = "package" ] || fail "$manifest package.prefix must be package"
[ "$binary_path" = "bin/pnpm.mjs" ] || fail "$manifest package.binary_path must be bin/pnpm.mjs"
[ "$companion_path" = "bin/pnpx.mjs" ] || fail "$manifest package.companion_path must be bin/pnpx.mjs"
[ "$payload_path" = "dist/pnpm.mjs" ] || fail "$manifest package.payload_path must be dist/pnpm.mjs"
[ "$executable_paths" = "$expected_executable_paths" ] ||
  fail "$manifest package.executable_paths must be $expected_executable_paths"
IFS=',' read -r -a executables <<<"$executable_paths"
for digest in "$archive_sha256" "$tree_sha256" "$binary_sha256" "$companion_sha256" "$payload_sha256"; do
  validate_sha256 "$digest" "$manifest package digest"
done
validate_sha512 "$archive_sha512" "$manifest package.sha512"
for value in "$archive_bytes" "$expanded_bytes" "$entry_count" "$file_count"; do
  validate_count "$value" "$manifest package count"
done

case "$cache_root" in
  '' | /) fail "unsafe pnpm cache root: $cache_root" ;;
esac
if [ -L "$cache_root" ]; then
  fail "pnpm cache root must not be a symbolic link: $cache_root"
fi
umask 077
mkdir -p "$cache_root"
if [ ! -d "$cache_root" ] || [ -L "$cache_root" ]; then
  fail "pnpm cache root is not a real directory: $cache_root"
fi
archive_root="$cache_root/archives"
installations_root="$cache_root/installations"
for path in "$archive_root" "$installations_root"; do
  [ ! -L "$path" ] || fail "pnpm cache must not contain symbolic-link directories: $path"
  mkdir -p "$path"
  if [ ! -d "$path" ] || [ -L "$path" ]; then
    fail "pnpm cache path is not a real directory: $path"
  fi
done

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
  local output="$1"
  local actual_size
  if [ -f "$output" ] && [ ! -L "$output" ]; then
    actual_size="$(wc -c <"$output" | tr -d '[:space:]')"
    if [ "$actual_size" = "$archive_bytes" ] &&
      [ "$(sha256_file "$output")" = "$archive_sha256" ] &&
      [ "$(sha512_file "$output")" = "$archive_sha512" ]; then
      return 0
    fi
  fi
  rm -f "$output"
  local partial
  local rc=0
  partial="$(mktemp "$archive_root/.download.XXXXXX")"
  local args=("${curl_common[@]}" --max-filesize "$archive_bytes" --output "$partial" "$url")
  if "$curl_command" "${args[@]}"; then
    :
  else
    rc=$?
    rm -f "$partial"
    return "$rc"
  fi
  actual_size="$(wc -c <"$partial" | tr -d '[:space:]')"
  [ "$actual_size" = "$archive_bytes" ] || {
    rm -f "$partial"
    fail "downloaded byte-size mismatch for $url: expected $archive_bytes, got $actual_size"
  }
  [ "$(sha256_file "$partial")" = "$archive_sha256" ] || {
    rm -f "$partial"
    fail "downloaded SHA-256 mismatch for $url"
  }
  [ "$(sha512_file "$partial")" = "$archive_sha512" ] || {
    rm -f "$partial"
    fail "downloaded SHA-512 mismatch for $url"
  }
  chmod 0444 "$partial"
  mv "$partial" "$output"
}

identity="pnpm-$version-$archive_sha256"
install_parent="$installations_root/$identity"
[ ! -L "$install_parent" ] || fail "pnpm installation parent must not be a symbolic link"
mkdir -p "$install_parent"
if [ ! -d "$install_parent" ] || [ -L "$install_parent" ]; then
  fail "pnpm installation parent is not a real directory"
fi
final="$install_parent/verified"
receipt_text="$(printf 'pnpm_version=%s\narchive_sha256=%s\narchive_sha512=%s\ntree_sha256=%s' \
  "$version" "$archive_sha256" "$archive_sha512" "$tree_sha256")"
# These literal lines become the cached wrapper.
# shellcheck disable=SC2016
pnpm_wrapper_text="$(printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"' \
  'exec node "$script_dir/../pnpm/bin/pnpm.mjs" "$@"')"
# These literal lines become the cached wrapper.
# shellcheck disable=SC2016
pnpx_wrapper_text="$(printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"' \
  'exec node "$script_dir/../pnpm/bin/pnpx.mjs" "$@"')"
pnpm_cmd_text="$(printf '%s\r\n' '@ECHO OFF' 'node "%~dp0..\pnpm\bin\pnpm.mjs" %*')"
pnpx_cmd_text="$(printf '%s\r\n' '@ECHO OFF' 'node "%~dp0..\pnpm\bin\pnpx.mjs" %*')"

cache_valid() {
  local candidate="$1"
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || return 1
  [ "$(find "$candidate" -mindepth 1 -maxdepth 1 | wc -l | tr -d '[:space:]')" = "3" ] || return 1
  [ -d "$candidate/bin" ] && [ ! -L "$candidate/bin" ] || return 1
  [ -d "$candidate/pnpm" ] && [ ! -L "$candidate/pnpm" ] || return 1
  [ "$(find "$candidate/bin" -mindepth 1 -maxdepth 1 | wc -l | tr -d '[:space:]')" = "4" ] || return 1
  for path in \
    "$candidate/pnpm/$binary_path" \
    "$candidate/pnpm/$companion_path" \
    "$candidate/pnpm/$payload_path" \
    "$candidate/bin/pnpm" \
    "$candidate/bin/pnpx" \
    "$candidate/bin/pnpm.cmd" \
    "$candidate/bin/pnpx.cmd" \
    "$candidate/receipt"; do
    [ -f "$path" ] && [ ! -L "$path" ] || return 1
  done
  [ "$(sha256_file "$candidate/pnpm/$binary_path")" = "$binary_sha256" ] || return 1
  [ "$(sha256_file "$candidate/pnpm/$companion_path")" = "$companion_sha256" ] || return 1
  [ "$(sha256_file "$candidate/pnpm/$payload_path")" = "$payload_sha256" ] || return 1
  [ "$(cat "$candidate/bin/pnpm")" = "$pnpm_wrapper_text" ] || return 1
  [ "$(cat "$candidate/bin/pnpx")" = "$pnpx_wrapper_text" ] || return 1
  [ "$(cat "$candidate/bin/pnpm.cmd")" = "$pnpm_cmd_text" ] || return 1
  [ "$(cat "$candidate/bin/pnpx.cmd")" = "$pnpx_cmd_text" ] || return 1
  if [ "$(uname -s)" != "Windows_NT" ]; then
    [ -x "$candidate/bin/pnpm" ] && [ -x "$candidate/bin/pnpx" ] || return 1
  fi
  local tree_result
  local tree_args=(tree-digest --root "$candidate/pnpm")
  local executable
  for executable in "${executables[@]}"; do
    tree_args+=(--executable "$executable")
  done
  tree_result="$("$python" "$extractor" "${tree_args[@]}" 2>/dev/null)" || return 1
  [ "$tree_result" = "$file_count $tree_sha256" ] || return 1
  [ "$(node "$candidate/pnpm/$binary_path" --version 2>/dev/null | awk 'NF { print $1; exit }')" = "$version" ] || return 1
  [ "$(cat "$candidate/receipt")" = "$receipt_text" ] || return 1
}

if cache_valid "$final"; then
  printf '%s\n' "$final"
  exit 0
fi

archive="$archive_root/$archive_sha256.tgz"
download_verified "$archive"

stage="$(mktemp -d "$install_parent/.verified.stage.XXXXXX")"
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

extract_args=(
  extract
  --archive "$archive"
  --format "$format"
  --prefix "$prefix"
  --entry-count "$entry_count"
  --expected-bytes "$archive_bytes"
  --expanded-bytes "$expanded_bytes"
  --destination "$stage/pnpm"
  --required "$binary_path"
  --required "$companion_path"
  --required "$payload_path"
  --required package.json
)
for executable in "${executables[@]}"; do
  extract_args+=(--required "$executable" --executable "$executable")
done
"$python" "$extractor" "${extract_args[@]}"

mkdir -p "$stage/bin"
printf '%s\n' "$pnpm_wrapper_text" >"$stage/bin/pnpm"
printf '%s\n' "$pnpx_wrapper_text" >"$stage/bin/pnpx"
printf '%s\n' "$pnpm_cmd_text" >"$stage/bin/pnpm.cmd"
printf '%s\n' "$pnpx_cmd_text" >"$stage/bin/pnpx.cmd"
chmod 0555 "$stage/bin/pnpm" "$stage/bin/pnpx"
chmod 0444 "$stage/bin/pnpm.cmd" "$stage/bin/pnpx.cmd"
printf '%s\n' "$receipt_text" >"$stage/receipt"
chmod 0444 "$stage/receipt"

cache_valid "$stage" || fail "staged pnpm installation failed integrity or version validation"

if [ -e "$final" ] || [ -L "$final" ]; then
  backup="$(mktemp -d "$install_parent/.verified.backup.XXXXXX")"
  rmdir "$backup"
  mv "$final" "$backup"
  old_moved=1
fi
if [ "${OLIPHAUNT_PNPM_TEST_INTERRUPT_AFTER_BACKUP:-0}" = "1" ]; then
  [ "$testing" = "1" ] || fail "OLIPHAUNT_PNPM_TEST_INTERRUPT_AFTER_BACKUP is test-only"
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

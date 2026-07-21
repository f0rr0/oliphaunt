#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "setup-npm-publisher/install.sh: $*" >&2
  exit 1
}

root="${OLIPHAUNT_NPM_PUBLISHER_ROOT:-}"
if [ -z "$root" ]; then
  root="$(git rev-parse --show-toplevel 2>/dev/null)" ||
    fail "must run inside the Oliphaunt checkout"
fi
manifest="${OLIPHAUNT_NPM_PUBLISHER_MANIFEST:-$root/src/sources/toolchains/npm-publisher.toml}"
extractor="${OLIPHAUNT_NPM_PUBLISHER_ARCHIVE_EXTRACTOR:-$root/.github/actions/setup-moon/toolchain-archive.py}"
curl_platform_flags="$root/tools/dev/curl-platform-flags.sh"
cache_root="${OLIPHAUNT_NPM_PUBLISHER_CACHE_ROOT:-${RUNNER_TEMP:-$root/target}/oliphaunt-npm-publisher}"

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    command -v cygpath >/dev/null 2>&1 && cache_root="$(cygpath -u "$cache_root")"
    ;;
esac
for path in "$manifest" "$extractor" "$curl_platform_flags"; do
  [ -f "$path" ] && [ ! -L "$path" ] || fail "missing regular bootstrap input: $path"
done
# shellcheck source=tools/dev/curl-platform-flags.sh
. "$curl_platform_flags"

python=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then python="$candidate"; break; fi
done
[ -n "$python" ] || fail "python3 or python is required for safe archive extraction"
command -v node >/dev/null 2>&1 || fail "the verified Node.js runtime must be on PATH"

manifest_value() {
  local section="$1" key="$2"
  awk -v wanted_section="$section" -v wanted_key="$key" '
    /^[[:space:]]*\[[^]]+\][[:space:]]*$/ {
      current=$0; gsub(/^[[:space:]]*\[|\][[:space:]]*$/, "", current); next
    }
    current == wanted_section && $0 ~ "^[[:space:]]*" wanted_key "[[:space:]]*=" {
      count++; line=$0; sub(/^[^=]*=[[:space:]]*"/, "", line)
      sub(/"[[:space:]]*$/, "", line); value=line
    }
    END { if (count != 1 || value == "") exit 1; print value }
  ' "$manifest"
}
validate_digest() {
  [ "${#2}" -eq "$1" ] && [[ ! "$2" =~ [^0-9a-f] ]] ||
    fail "invalid lowercase hexadecimal digest in $manifest"
}
validate_count() {
  case "$1" in '' | *[!0-9]*) fail "invalid positive count in $manifest" ;; esac
  [ "$1" -gt 0 ] || fail "invalid positive count in $manifest"
}
hash_file() {
  local algorithm="$1" path="$2"
  if command -v "${algorithm}sum" >/dev/null 2>&1; then
    "${algorithm}sum" "$path" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    case "$algorithm" in
      sha256) shasum -a 256 "$path" | awk '{print $1}' ;;
      sha512) shasum -a 512 "$path" | awk '{print $1}' ;;
    esac
  else
    "$python" - "$algorithm" "$path" <<'PY'
import hashlib
import pathlib
import sys
digest = hashlib.new(sys.argv[1])
with pathlib.Path(sys.argv[2]).open("rb") as stream:
    while block := stream.read(1024 * 1024):
        digest.update(block)
print(digest.hexdigest())
PY
  fi
}

version="$(manifest_value toolchain version)" || fail "$manifest is missing toolchain.version"
url="$(manifest_value package url)" || fail "$manifest is missing package.url"
archive_sha256="$(manifest_value package sha256)" || fail "$manifest is missing package.sha256"
archive_sha512="$(manifest_value package sha512)" || fail "$manifest is missing package.sha512"
archive_bytes="$(manifest_value package bytes)" || fail "$manifest is missing package.bytes"
expanded_bytes="$(manifest_value package expanded_bytes)" || fail "$manifest is missing package.expanded_bytes"
format="$(manifest_value package format)" || fail "$manifest is missing package.format"
prefix="$(manifest_value package prefix)" || fail "$manifest is missing package.prefix"
entry_count="$(manifest_value package entry_count)" || fail "$manifest is missing package.entry_count"
file_count="$(manifest_value package file_count)" || fail "$manifest is missing package.file_count"
tree_sha256="$(manifest_value package tree_sha256)" || fail "$manifest is missing package.tree_sha256"
executable_paths="$(manifest_value package executable_paths)" || fail "$manifest is missing package.executable_paths"
binary_path="$(manifest_value package binary_path)" || fail "$manifest is missing package.binary_path"
binary_sha256="$(manifest_value package binary_sha256)" || fail "$manifest is missing package.binary_sha256"
binary_bytes="$(manifest_value package binary_bytes)" || fail "$manifest is missing package.binary_bytes"
companion_path="$(manifest_value package companion_path)" || fail "$manifest is missing package.companion_path"
companion_sha256="$(manifest_value package companion_sha256)" || fail "$manifest is missing package.companion_sha256"
companion_bytes="$(manifest_value package companion_bytes)" || fail "$manifest is missing package.companion_bytes"
package_json_sha256="$(manifest_value package package_json_sha256)" || fail "$manifest is missing package.package_json_sha256"
package_json_bytes="$(manifest_value package package_json_bytes)" || fail "$manifest is missing package.package_json_bytes"

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "npm version must be exact stable semver"
[ "$url" = "https://registry.npmjs.org/npm/-/npm-$version.tgz" ] || fail "npm archive URL is not canonical"
[ "$format" = tar.gz ] && [ "$prefix" = package ] || fail "npm archive shape is not canonical"
[ "$binary_path" = bin/npm-cli.js ] && [ "$companion_path" = bin/npx-cli.js ] ||
  fail "npm CLI paths are not canonical"
validate_digest 64 "$archive_sha256"
validate_digest 128 "$archive_sha512"
for digest in "$tree_sha256" "$binary_sha256" "$companion_sha256" "$package_json_sha256"; do
  validate_digest 64 "$digest"
done
for value in "$archive_bytes" "$expanded_bytes" "$entry_count" "$file_count" "$binary_bytes" "$companion_bytes" "$package_json_bytes"; do
  validate_count "$value"
done
IFS=',' read -r -a executables <<<"$executable_paths"
[ "${#executables[@]}" -gt 0 ] || fail "npm executable path inventory is empty"

curl_command="${OLIPHAUNT_NPM_PUBLISHER_CURL:-curl}"
command -v "$curl_command" >/dev/null 2>&1 || fail "missing required command: $curl_command"
command -v mktemp >/dev/null 2>&1 || fail "missing required command: mktemp"
[ ! -L "$cache_root" ] || fail "npm publisher cache root must not be a symbolic link"
umask 077
mkdir -p "$cache_root"
[ -d "$cache_root" ] && [ ! -L "$cache_root" ] || fail "npm publisher cache root is not a real directory"
archive_root="$cache_root/archives"
install_parent="$cache_root/installations/npm-$version"
for directory in "$archive_root" "$cache_root/installations" "$install_parent"; do
  [ ! -L "$directory" ] || fail "npm publisher cache must not contain symbolic-link directories"
  mkdir -p "$directory"
done

final="$install_parent/verified"
receipt_text="$(printf 'npm_version=%s\narchive_sha256=%s\ntree_sha256=%s' "$version" "$archive_sha256" "$tree_sha256")"
npm_wrapper_text="$(printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' \
  'script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"' \
  'exec node "$script_dir/../npm/bin/npm-cli.js" "$@"')"
npx_wrapper_text="$(printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' \
  'script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"' \
  'exec node "$script_dir/../npm/bin/npx-cli.js" "$@"')"
npm_cmd_text="$(printf '%s\r\n' '@ECHO OFF' 'node "%~dp0..\npm\bin\npm-cli.js" %*')"
npx_cmd_text="$(printf '%s\r\n' '@ECHO OFF' 'node "%~dp0..\npm\bin\npx-cli.js" %*')"

cache_valid() {
  local candidate="$1"
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || return 1
  [ "$(find "$candidate" -mindepth 1 -maxdepth 1 | wc -l | tr -d '[:space:]')" = 3 ] || return 1
  [ -d "$candidate/bin" ] && [ ! -L "$candidate/bin" ] || return 1
  [ -d "$candidate/npm" ] && [ ! -L "$candidate/npm" ] || return 1
  [ "$(find "$candidate/bin" -mindepth 1 -maxdepth 1 | wc -l | tr -d '[:space:]')" = 4 ] || return 1
  for path in "$candidate/npm/$binary_path" "$candidate/npm/$companion_path" \
    "$candidate/npm/package.json" "$candidate/bin/npm" "$candidate/bin/npx" \
    "$candidate/bin/npm.cmd" "$candidate/bin/npx.cmd" "$candidate/receipt"; do
    [ -f "$path" ] && [ ! -L "$path" ] || return 1
  done
  [ "$(wc -c <"$candidate/npm/$binary_path" | tr -d '[:space:]')" = "$binary_bytes" ] || return 1
  [ "$(wc -c <"$candidate/npm/$companion_path" | tr -d '[:space:]')" = "$companion_bytes" ] || return 1
  [ "$(wc -c <"$candidate/npm/package.json" | tr -d '[:space:]')" = "$package_json_bytes" ] || return 1
  [ "$(hash_file sha256 "$candidate/npm/$binary_path")" = "$binary_sha256" ] || return 1
  [ "$(hash_file sha256 "$candidate/npm/$companion_path")" = "$companion_sha256" ] || return 1
  [ "$(hash_file sha256 "$candidate/npm/package.json")" = "$package_json_sha256" ] || return 1
  [ "$(cat "$candidate/bin/npm")" = "$npm_wrapper_text" ] || return 1
  [ "$(cat "$candidate/bin/npx")" = "$npx_wrapper_text" ] || return 1
  [ "$(cat "$candidate/bin/npm.cmd")" = "$npm_cmd_text" ] || return 1
  [ "$(cat "$candidate/bin/npx.cmd")" = "$npx_cmd_text" ] || return 1
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) ;;
    *) [ -x "$candidate/bin/npm" ] && [ -x "$candidate/bin/npx" ] || return 1 ;;
  esac
  local args=(tree-digest --root "$candidate/npm") executable
  for executable in "${executables[@]}"; do args+=(--executable "$executable"); done
  [ "$("$python" "$extractor" "${args[@]}" 2>/dev/null)" = "$file_count $tree_sha256" ] || return 1
  [ "$(node "$candidate/npm/$binary_path" --version 2>/dev/null)" = "$version" ] || return 1
  [ "$(cat "$candidate/receipt")" = "$receipt_text" ] || return 1
}

if cache_valid "$final"; then printf '%s\n' "$final/bin"; exit 0; fi
archive="$archive_root/$archive_sha256.tgz"
if ! { [ -f "$archive" ] && [ ! -L "$archive" ] &&
  [ "$(wc -c <"$archive" | tr -d '[:space:]')" = "$archive_bytes" ] &&
  [ "$(hash_file sha256 "$archive")" = "$archive_sha256" ] &&
  [ "$(hash_file sha512 "$archive")" = "$archive_sha512" ]; }; then
  rm -f "$archive"
  partial="$(mktemp "$archive_root/.download.XXXXXX")"
  tls_flag="$(oliphaunt_curl_platform_tls_flag)"
  curl_args=(--fail --location --silent --show-error --proto '=https' --proto-redir '=https'
    --tlsv1.2 --retry 5 --retry-all-errors --retry-connrefused --retry-delay 2
    --retry-max-time 300 --connect-timeout 20 --max-time 300 --speed-limit 1024
    --speed-time 30 --remove-on-error --max-filesize "$archive_bytes" --output "$partial")
  [ -z "$tls_flag" ] || curl_args+=("$tls_flag")
  curl_args+=("$url")
  if ! "$curl_command" "${curl_args[@]}"; then
    rm -f "$partial"; fail "could not download pinned npm publisher archive"
  fi
  [ "$(wc -c <"$partial" | tr -d '[:space:]')" = "$archive_bytes" ] &&
    [ "$(hash_file sha256 "$partial")" = "$archive_sha256" ] &&
    [ "$(hash_file sha512 "$partial")" = "$archive_sha512" ] || {
      rm -f "$partial"; fail "downloaded npm publisher archive integrity mismatch"
    }
  chmod 0444 "$partial"
  mv "$partial" "$archive"
fi

stage="$(mktemp -d "$install_parent/.verified.stage.XXXXXX")"
backup=""
old_moved=0
cleanup() {
  local rc="$?"
  trap - EXIT HUP INT TERM
  rm -rf "$stage"
  if [ "$old_moved" = 1 ] && [ -n "$backup" ] && [ -e "$backup" ] && [ ! -e "$final" ]; then
    mv "$backup" "$final" || rc=1
  elif [ -n "$backup" ]; then rm -rf "$backup"; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

extract_args=(extract --archive "$archive" --format "$format" --prefix "$prefix"
  --entry-count "$entry_count" --expected-bytes "$archive_bytes"
  --expanded-bytes "$expanded_bytes" --destination "$stage/npm"
  --required "$binary_path" --required "$companion_path" --required package.json)
for executable in "${executables[@]}"; do
  extract_args+=(--required "$executable" --executable "$executable")
done
"$python" "$extractor" "${extract_args[@]}"
mkdir -p "$stage/bin"
printf '%s\n' "$npm_wrapper_text" >"$stage/bin/npm"
printf '%s\n' "$npx_wrapper_text" >"$stage/bin/npx"
printf '%s\n' "$npm_cmd_text" >"$stage/bin/npm.cmd"
printf '%s\n' "$npx_cmd_text" >"$stage/bin/npx.cmd"
chmod 0555 "$stage/bin/npm" "$stage/bin/npx"
chmod 0444 "$stage/bin/npm.cmd" "$stage/bin/npx.cmd"
printf '%s\n' "$receipt_text" >"$stage/receipt"
chmod 0444 "$stage/receipt"
cache_valid "$stage" || fail "staged npm publisher failed integrity or version validation"

if [ -e "$final" ] || [ -L "$final" ]; then
  backup="$(mktemp -d "$install_parent/.verified.backup.XXXXXX")"; rmdir "$backup"
  mv "$final" "$backup"; old_moved=1
fi
if [ "${OLIPHAUNT_NPM_PUBLISHER_TEST_INTERRUPT_AFTER_BACKUP:-0}" = 1 ]; then
  [ "${OLIPHAUNT_NPM_PUBLISHER_TESTING:-0}" = 1 ] ||
    fail "OLIPHAUNT_NPM_PUBLISHER_TEST_INTERRUPT_AFTER_BACKUP is test-only"
  kill -TERM "$$"
fi
mv "$stage" "$final"; stage=""
if [ "$old_moved" = 1 ]; then rm -rf "$backup"; backup=""; old_moved=0; fi
printf '%s\n' "$final/bin"

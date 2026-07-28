#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "install-pinned-js-runtime.sh: $*" >&2
  exit 1
}

root="${OLIPHAUNT_PINNED_TOOL_ROOT:-}"
if [ -z "$root" ]; then
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "must run inside the Oliphaunt checkout"
fi
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tool="${1:-}"
shift || true
expected_input=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --expected-version) expected_input="${2:-}"; shift 2 ;;
    *) fail "unknown or incomplete option: $1" ;;
  esac
done
case "$tool" in
  bun|deno) ;;
  *) fail "usage: install-pinned-js-runtime.sh <bun|deno> [--expected-version VERSION]" ;;
esac

case "$tool" in
  bun) manifest="${OLIPHAUNT_BUN_TOOLCHAIN_MANIFEST:-$root/src/sources/toolchains/bun.toml}" ;;
  deno) manifest="${OLIPHAUNT_DENO_TOOLCHAIN_MANIFEST:-$root/src/sources/toolchains/deno.toml}" ;;
esac
proto_file="${OLIPHAUNT_PINNED_TOOL_PROTO_FILE:-$root/.prototools}"
extractor="${OLIPHAUNT_PINNED_ZIP_EXTRACTOR:-$root/tools/dev/extract-pinned-zip.sh}"
curl_platform_flags="$script_dir/curl-platform-flags.sh"
cache_root="${OLIPHAUNT_PINNED_TOOL_CACHE_ROOT:-$root/target/oliphaunt-tools}"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    if command -v cygpath >/dev/null 2>&1; then
      cache_root="$(cygpath -u "$cache_root")"
    fi
    ;;
esac
[ -f "$manifest" ] || fail "missing $tool manifest: $manifest"
[ -f "$proto_file" ] || fail "missing tool version file: $proto_file"
[ -x "$extractor" ] || fail "missing executable pinned ZIP extractor: $extractor"
if [ ! -f "$curl_platform_flags" ] || [ -L "$curl_platform_flags" ]; then
  fail "missing regular curl platform policy: $curl_platform_flags"
fi
# shellcheck source=tools/dev/curl-platform-flags.sh disable=SC1091
. "$curl_platform_flags"

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
    END {
      if (count != 1 || value == "") exit 1
      print value
    }
  ' "$manifest"
}

proto_version() {
  awk -F '=' -v wanted="$tool" '
    $1 ~ "^[[:space:]]*" wanted "[[:space:]]*$" {
      count++
      value=$2
      gsub(/^[[:space:]"]+|[[:space:]"]+$/, "", value)
    }
    END { if (count != 1 || value == "") exit 1; print value }
  ' "$proto_file"
}

version="$(manifest_value toolchain version)" || fail "$manifest must contain exactly one quoted toolchain.version"
case "$version" in
  ''|.*|*.|*..*|*[!0-9.]*) fail "invalid $tool version in $manifest: $version" ;;
esac
[ "$(awk -F. 'NF == 3 { print "valid" }' <<<"$version")" = "valid" ] ||
  fail "invalid $tool version in $manifest: $version"
configured_version="$(proto_version)" || fail "$proto_file must contain exactly one $tool version"
configured_version="${configured_version#v}"
[ "$configured_version" = "$version" ] ||
  fail "$proto_file $tool version $configured_version does not match $manifest version $version"
if [ -n "$expected_input" ]; then
  expected_input="${expected_input#v}"
  [ "$expected_input" = "$version" ] ||
    fail "requested $tool version $expected_input does not match pinned version $version"
fi

if [ -n "${OLIPHAUNT_PINNED_TOOL_TARGET:-}" ]; then
  target="$OLIPHAUNT_PINNED_TOOL_TARGET"
else
  case "$tool:$(uname -s):$(uname -m)" in
    bun:Darwin:arm64|bun:Darwin:aarch64) target="darwin-aarch64" ;;
    bun:Darwin:x86_64) target="darwin-x64" ;;
    bun:Linux:arm64|bun:Linux:aarch64) target="linux-aarch64" ;;
    bun:Linux:x86_64) target="linux-x64" ;;
    bun:MINGW*:x86_64|bun:MSYS*:x86_64|bun:CYGWIN*:x86_64|bun:MINGW*:AMD64|bun:MSYS*:AMD64|bun:CYGWIN*:AMD64) target="windows-x64" ;;
    deno:Darwin:arm64|deno:Darwin:aarch64) target="aarch64-apple-darwin" ;;
    deno:Darwin:x86_64) target="x86_64-apple-darwin" ;;
    deno:Linux:arm64|deno:Linux:aarch64) target="aarch64-unknown-linux-gnu" ;;
    deno:Linux:x86_64) target="x86_64-unknown-linux-gnu" ;;
    deno:MINGW*:x86_64|deno:MSYS*:x86_64|deno:CYGWIN*:x86_64|deno:MINGW*:AMD64|deno:MSYS*:AMD64|deno:CYGWIN*:AMD64) target="x86_64-pc-windows-msvc" ;;
    *) fail "unsupported $tool host: $(uname -s)-$(uname -m)" ;;
  esac
fi

section="assets.$target"
url="$(manifest_value "$section" url)" || fail "$manifest is missing $section.url"
archive_sha256="$(manifest_value "$section" sha256)" || fail "$manifest is missing $section.sha256"
binary_path="$(manifest_value "$section" binary_path)" || fail "$manifest is missing $section.binary_path"
binary_sha256="$(manifest_value "$section" binary_sha256)" || fail "$manifest is missing $section.binary_sha256"
entry_count="$(manifest_value "$section" entry_count)" || fail "$manifest is missing $section.entry_count"
mirror_url="$(manifest_value "$section" mirror_url 2>/dev/null || true)"

for digest in "$archive_sha256" "$binary_sha256"; do
  if [ "${#digest}" -ne 64 ] || [[ "$digest" =~ [^0-9a-f] ]]; then
    fail "$manifest $section digests must contain exactly 64 lowercase hexadecimal characters"
  fi
done
case "$entry_count" in ''|*[!0-9]*) fail "$manifest $section.entry_count must be numeric" ;; esac

case "$tool:$target" in
  bun:windows-*) exe_name="bun.exe" ;;
  bun:*) exe_name="bun" ;;
  deno:*windows*) exe_name="deno.exe" ;;
  deno:*) exe_name="deno" ;;
esac

if [ "$tool" = "bun" ]; then
  asset="bun-$target.zip"
  expected_url="https://github.com/oven-sh/bun/releases/download/bun-v$version/$asset"
  expected_binary_path="bun-$target/$exe_name"
  expected_mirror=""
else
  asset="deno-$target.zip"
  expected_url="https://github.com/denoland/deno/releases/download/v$version/$asset"
  expected_mirror="https://dl.deno.land/release/v$version/$asset"
  expected_binary_path="$exe_name"
fi
[ "$url" = "$expected_url" ] || fail "$manifest $section.url must be $expected_url"
[ "$mirror_url" = "$expected_mirror" ] || fail "$manifest $section.mirror_url must be ${expected_mirror:-absent}"
[ "$binary_path" = "$expected_binary_path" ] ||
  fail "$manifest $section.binary_path must be $expected_binary_path"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "sha256sum or shasum is required"
  fi
}

binary_version() {
  local binary="$1"
  local output
  output="$("$binary" --version 2>/dev/null)" || return 1
  if [ "$tool" = "bun" ]; then
    printf '%s\n' "$output" | awk 'NF { print $1; exit }'
  else
    printf '%s\n' "$output" | awk 'NR == 1 && $1 == "deno" { print $2 }'
  fi
}

mode_style=""
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT) ;;
  *)
    if stat -c '%a' "$manifest" >/dev/null 2>&1; then
      mode_style="gnu"
    elif stat -f '%Lp' "$manifest" >/dev/null 2>&1; then
      mode_style="bsd"
    fi
    ;;
esac

portable_mode() {
  case "$mode_style" in
    gnu) stat -c '%a' "$1" 2>/dev/null ;;
    bsd) stat -f '%Lp' "$1" 2>/dev/null ;;
    *) return 1 ;;
  esac
}

receipt_text="$(printf 'tool=%s\nversion=%s\ntarget=%s\narchive_sha256=%s\nbinary_sha256=%s' \
  "$tool" "$version" "$target" "$archive_sha256" "$binary_sha256")"
receipt_bytes="$(printf '%s\n' "$receipt_text" | wc -c | tr -d '[:space:]')"

cache_valid() {
  local candidate="$1"
  local binary="$candidate/bin/$exe_name"
  local mode=""
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || return 1
  [ "$(find "$candidate" -mindepth 1 -maxdepth 1 | wc -l | tr -d '[:space:]')" = "2" ] || return 1
  [ -d "$candidate/bin" ] && [ ! -L "$candidate/bin" ] || return 1
  [ "$(find "$candidate/bin" -mindepth 1 -maxdepth 1 | wc -l | tr -d '[:space:]')" = "1" ] || return 1
  [ -f "$binary" ] && [ ! -L "$binary" ] || return 1
  [ -f "$candidate/receipt" ] && [ ! -L "$candidate/receipt" ] || return 1
  case "$target" in
    windows-*|x86_64-pc-windows-msvc) ;;
    *) [ -x "$binary" ] || return 1 ;;
  esac
  [ "$(sha256_file "$binary")" = "$binary_sha256" ] || return 1
  [ "$(binary_version "$binary")" = "$version" ] || return 1
  [ "$(wc -c <"$candidate/receipt" | tr -d '[:space:]')" = "$receipt_bytes" ] || return 1
  [ "$(cat "$candidate/receipt")" = "$receipt_text" ] || return 1
  if [ -n "$mode_style" ]; then
    mode="$(portable_mode "$candidate")" || return 1
    [ "$mode" = "700" ] || return 1
    mode="$(portable_mode "$candidate/bin")" || return 1
    [ "$mode" = "700" ] || return 1
    mode="$(portable_mode "$binary")" || return 1
    [ "$mode" = "555" ] || return 1
    mode="$(portable_mode "$candidate/receipt")" || return 1
    [ "$mode" = "444" ] || return 1
  fi
}

tool_cache="$cache_root/$tool"
parent="$tool_cache/v$version"
final="$parent/$target"
final_binary="$final/bin/$exe_name"
if [ -L "$cache_root" ]; then
  fail "$tool cache root must not be a symbolic link: $cache_root"
fi
umask 077
mkdir -p "$cache_root"
if [ ! -d "$cache_root" ] || [ -L "$cache_root" ]; then
  fail "$tool cache root is not a real directory: $cache_root"
fi
for directory in "$tool_cache" "$parent"; do
  [ ! -L "$directory" ] || fail "$tool cache must not contain symbolic-link directories: $directory"
  mkdir -p "$directory"
  if [ ! -d "$directory" ] || [ -L "$directory" ]; then
    fail "$tool cache directory is not real: $directory"
  fi
done
if cache_valid "$final"; then
  printf '%s\n' "$final_binary"
  exit 0
fi

for command_name in "${OLIPHAUNT_PINNED_TOOL_CURL:-curl}" mktemp; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing required command: $command_name"
done
archive="$(mktemp "$parent/.$target.archive.XXXXXX")"
stage="$(mktemp -d "$parent/.$target.stage.XXXXXX")"
backup=""
old_moved=0
cleanup() {
  local status="$?"
  trap - EXIT HUP INT TERM
  rm -f "$archive"
  if [ -n "$stage" ]; then
    rm -rf "$stage"
  fi
  if [ "$old_moved" = "1" ] && [ -n "$backup" ] && [ -e "$backup" ] && [ ! -e "$final" ]; then
    mv "$backup" "$final" || status=1
  elif [ -n "$backup" ]; then
    rm -rf "$backup"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

downloaded=0
curl_platform_tls_flag="$(oliphaunt_curl_platform_tls_flag)"
for candidate_url in "$url" ${mirror_url:+"$mirror_url"}; do
  rm -f "$archive"
  curl_args=(
    --fail --location --silent --show-error
    --proto '=https' --proto-redir '=https'
    --retry 5 --retry-all-errors --retry-delay 2 --retry-max-time 120
    --connect-timeout 20 --max-time 180 --max-filesize 200000000
  )
  if [ -n "$curl_platform_tls_flag" ]; then
    curl_args+=("$curl_platform_tls_flag")
  fi
  curl_args+=(--remove-on-error --output "$archive" "$candidate_url")
  if "${OLIPHAUNT_PINNED_TOOL_CURL:-curl}" "${curl_args[@]}"; then
    actual_archive_sha256="$(sha256_file "$archive")"
    if [ "$actual_archive_sha256" = "$archive_sha256" ]; then
      downloaded=1
      break
    fi
    echo "$tool archive checksum mismatch from $candidate_url; trying the next pinned origin" >&2
  fi
done
[ "$downloaded" = "1" ] || fail "could not download the verified $tool $version $target archive"

extract_args=(
  --archive "$archive"
  --destination "$stage/extracted"
  --entry-count "$entry_count"
  --required "$binary_path"
  --executable "$binary_path"
)
case "$binary_path" in
  */*) extract_args+=(--prefix "${binary_path%%/*}") ;;
esac
"$extractor" "${extract_args[@]}"
mkdir -p "$stage/bin"
mv "$stage/extracted/$binary_path" "$stage/bin/$exe_name"
rm -rf "$stage/extracted"
chmod 0700 "$stage" "$stage/bin"
chmod 0555 "$stage/bin/$exe_name"
printf '%s\n' "$receipt_text" >"$stage/receipt"
chmod 0444 "$stage/receipt"
cache_valid "$stage" || fail "staged $tool cache envelope failed integrity or version validation"

if [ -e "$final" ] || [ -L "$final" ]; then
  backup="$(mktemp -d "$parent/.$target.backup.XXXXXX")"
  rmdir "$backup"
  mv "$final" "$backup"
  old_moved=1
fi
if [ "${OLIPHAUNT_PINNED_TOOL_TEST_INTERRUPT_AFTER_BACKUP:-0}" = "1" ]; then
  [ "${OLIPHAUNT_PINNED_TOOL_TESTING:-0}" = "1" ] ||
    fail "OLIPHAUNT_PINNED_TOOL_TEST_INTERRUPT_AFTER_BACKUP requires OLIPHAUNT_PINNED_TOOL_TESTING=1"
  kill -TERM "$$"
fi
mv "$stage" "$final"
stage=""
if [ "$old_moved" = "1" ]; then
  rm -rf "$backup"
  backup=""
  old_moved=0
fi
rm -f "$archive"
archive=""
printf '%s\n' "$final_binary"

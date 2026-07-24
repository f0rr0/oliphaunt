#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "install-pinned-winflexbison.sh: $*" >&2
  exit 1
}

root="${OLIPHAUNT_PINNED_TOOL_ROOT:-}"
if [ -z "$root" ]; then
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "must run inside the Oliphaunt checkout"
fi
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
manifest="${OLIPHAUNT_WINFLEXBISON_MANIFEST:-$root/src/sources/toolchains/winflexbison.toml}"
extractor="${OLIPHAUNT_PINNED_ZIP_EXTRACTOR:-$root/tools/dev/extract-pinned-zip.sh}"
curl_platform_flags="$script_dir/curl-platform-flags.sh"
cache_root="${OLIPHAUNT_PINNED_NATIVE_TOOL_CACHE_ROOT:-$root/target/oliphaunt-native-tools}"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    if command -v cygpath >/dev/null 2>&1; then
      cache_root="$(cygpath -u "$cache_root")"
    fi
    ;;
esac
[ -f "$manifest" ] && [ ! -L "$manifest" ] || fail "missing regular winflexbison manifest: $manifest"
[ -x "$extractor" ] || fail "missing executable pinned ZIP extractor: $extractor"
[ -f "$curl_platform_flags" ] && [ ! -L "$curl_platform_flags" ] ||
  fail "missing regular curl platform policy: $curl_platform_flags"
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

version="$(manifest_value toolchain version)" || fail "$manifest must contain one quoted toolchain.version"
repository="$(manifest_value toolchain repository)" || fail "$manifest must contain one quoted toolchain.repository"
section="assets.windows-x64"
url="$(manifest_value "$section" url)" || fail "$manifest is missing $section.url"
archive_sha256="$(manifest_value "$section" sha256)" || fail "$manifest is missing $section.sha256"
archive_bytes="$(manifest_value "$section" bytes)" || fail "$manifest is missing $section.bytes"
entry_count="$(manifest_value "$section" entry_count)" || fail "$manifest is missing $section.entry_count"
file_count="$(manifest_value "$section" file_count)" || fail "$manifest is missing $section.file_count"
expanded_bytes="$(manifest_value "$section" expanded_bytes)" || fail "$manifest is missing $section.expanded_bytes"
tree_sha256="$(manifest_value "$section" tree_sha256)" || fail "$manifest is missing $section.tree_sha256"
flex_path="$(manifest_value "$section" flex_path)" || fail "$manifest is missing $section.flex_path"
flex_sha256="$(manifest_value "$section" flex_sha256)" || fail "$manifest is missing $section.flex_sha256"
bison_path="$(manifest_value "$section" bison_path)" || fail "$manifest is missing $section.bison_path"
bison_sha256="$(manifest_value "$section" bison_sha256)" || fail "$manifest is missing $section.bison_sha256"

case "$version" in
  ''|.*|*.|*..*|*[!0-9.]*) fail "invalid winflexbison version: $version" ;;
esac
[ "$(awk -F. 'NF == 3 { print "valid" }' <<<"$version")" = "valid" ] ||
  fail "invalid winflexbison version: $version"
[ "$repository" = "lexxmark/winflexbison" ] || fail "unsupported winflexbison repository: $repository"
expected_url="https://github.com/$repository/releases/download/v$version/win_flex_bison-$version.zip"
[ "$url" = "$expected_url" ] || fail "$manifest $section.url must be $expected_url"
[ "$flex_path" = "win_flex.exe" ] || fail "$manifest must pin flex_path to win_flex.exe"
[ "$bison_path" = "win_bison.exe" ] || fail "$manifest must pin bison_path to win_bison.exe"
for digest in "$archive_sha256" "$tree_sha256" "$flex_sha256" "$bison_sha256"; do
  [ "${#digest}" -eq 64 ] && [[ ! "$digest" =~ [^0-9a-f] ]] ||
    fail "$manifest digests must contain exactly 64 lowercase hexadecimal characters"
done
for number in "$archive_bytes" "$entry_count" "$file_count" "$expanded_bytes"; do
  case "$number" in ''|*[!0-9]*) fail "$manifest contains a non-numeric size or count" ;; esac
done
[ "$archive_bytes" -ge 1 ] && [ "$archive_bytes" -le 2000000 ] || fail "archive byte bound is invalid"
[ "$entry_count" -ge 2 ] && [ "$entry_count" -le 256 ] || fail "archive entry bound is invalid"
[ "$file_count" -ge 2 ] && [ "$file_count" -le "$entry_count" ] || fail "payload file bound is invalid"
[ "$expanded_bytes" -ge 1 ] && [ "$expanded_bytes" -le 10000000 ] ||
  fail "expanded byte bound is invalid"

python_bin="${OLIPHAUNT_WINFLEXBISON_PYTHON:-}"
if [ -z "$python_bin" ]; then
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 &&
      "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 8) else 1)'; then
      python_bin="$candidate"
      break
    fi
  done
fi
[ -n "$python_bin" ] || fail "Python 3.8 or newer is required"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print tolower($1)}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print tolower($1)}'
  else
    fail "sha256sum or shasum is required"
  fi
}

payload_identity() {
  "$python_bin" - "$1" <<'PY'
import hashlib
import os
import stat
import sys
from pathlib import Path

root = Path(sys.argv[1])
if not root.is_dir() or root.is_symlink():
    raise SystemExit(1)
files = []
for current, directories, names in os.walk(root, topdown=True, followlinks=False):
    current_path = Path(current)
    for name in directories:
        path = current_path / name
        mode = os.lstat(path).st_mode
        if not stat.S_ISDIR(mode) or stat.S_ISLNK(mode):
            raise SystemExit(1)
    for name in names:
        path = current_path / name
        mode = os.lstat(path).st_mode
        if not stat.S_ISREG(mode) or stat.S_ISLNK(mode):
            raise SystemExit(1)
        relative = path.relative_to(root).as_posix()
        if any(ord(character) < 0x20 or ord(character) == 0x7F for character in relative):
            raise SystemExit(1)
        files.append((relative, path))
digest = hashlib.sha256()
expanded = 0
for relative, path in sorted(files, key=lambda item: item[0].encode("utf-8")):
    file_digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            size += len(chunk)
            file_digest.update(chunk)
    expanded += size
    row = f"{relative}\0{size}\0{file_digest.hexdigest()}\n".encode("utf-8")
    digest.update(row)
print(f"{digest.hexdigest()}\t{len(files)}\t{expanded}")
PY
}

receipt_text="$(printf 'tool=winflexbison\nversion=%s\narchive_sha256=%s\ntree_sha256=%s\nflex_sha256=%s\nbison_sha256=%s' \
  "$version" "$archive_sha256" "$tree_sha256" "$flex_sha256" "$bison_sha256")"
receipt_bytes="$(printf '%s\n' "$receipt_text" | wc -c | tr -d '[:space:]')"

cache_valid() {
  local candidate="$1"
  local payload="$candidate/payload"
  local identity observed_tree observed_files observed_expanded
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || return 1
  [ "$(find "$candidate" -mindepth 1 -maxdepth 1 | wc -l | tr -d '[:space:]')" = "2" ] || return 1
  [ -d "$payload" ] && [ ! -L "$payload" ] || return 1
  [ -f "$candidate/receipt" ] && [ ! -L "$candidate/receipt" ] || return 1
  [ "$(wc -c <"$candidate/receipt" | tr -d '[:space:]')" = "$receipt_bytes" ] || return 1
  [ "$(cat "$candidate/receipt")" = "$receipt_text" ] || return 1
  identity="$(payload_identity "$payload")" || return 1
  IFS=$'\t' read -r observed_tree observed_files observed_expanded <<<"$identity"
  [ "$observed_tree" = "$tree_sha256" ] || return 1
  [ "$observed_files" = "$file_count" ] || return 1
  [ "$observed_expanded" = "$expanded_bytes" ] || return 1
  [ -f "$payload/$flex_path" ] && [ ! -L "$payload/$flex_path" ] || return 1
  [ -f "$payload/$bison_path" ] && [ ! -L "$payload/$bison_path" ] || return 1
  [ "$(sha256_file "$payload/$flex_path")" = "$flex_sha256" ] || return 1
  [ "$(sha256_file "$payload/$bison_path")" = "$bison_sha256" ] || return 1
}

tool_cache="$cache_root/winflexbison"
parent="$tool_cache/v$version"
final="$parent/windows-x64"
if [ -L "$cache_root" ]; then
  fail "winflexbison cache root must not be a symbolic link: $cache_root"
fi
umask 077
mkdir -p "$cache_root"
[ -d "$cache_root" ] && [ ! -L "$cache_root" ] || fail "winflexbison cache root is not a real directory"
for directory in "$tool_cache" "$parent"; do
  [ ! -L "$directory" ] || fail "winflexbison cache contains a symbolic-link directory: $directory"
  mkdir -p "$directory"
  [ -d "$directory" ] && [ ! -L "$directory" ] || fail "winflexbison cache directory is not real: $directory"
done
if cache_valid "$final"; then
  printf '%s\n' "$final/payload"
  exit 0
fi

curl_command="${OLIPHAUNT_WINFLEXBISON_CURL:-curl}"
for command_name in "$curl_command" mktemp; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing required command: $command_name"
done
archive="$(mktemp "$parent/.windows-x64.archive.XXXXXX")"
stage="$(mktemp -d "$parent/.windows-x64.stage.XXXXXX")"
backup=""
old_moved=0
cleanup() {
  local status="$?"
  trap - EXIT HUP INT TERM
  rm -f "$archive"
  if [ -n "$stage" ]; then rm -rf "$stage"; fi
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

curl_args=(
  --fail --location --silent --show-error
  --proto '=https' --proto-redir '=https'
  --retry 5 --retry-all-errors --retry-delay 2 --retry-max-time 120
  --connect-timeout 20 --max-time 180 --max-filesize 2000000
)
curl_platform_tls_flag="$(oliphaunt_curl_platform_tls_flag)"
if [ -n "$curl_platform_tls_flag" ]; then curl_args+=("$curl_platform_tls_flag"); fi
curl_args+=(--remove-on-error --output "$archive" "$url")
"$curl_command" "${curl_args[@]}" || fail "could not download pinned winflexbison $version"
actual_bytes="$(wc -c <"$archive" | tr -d '[:space:]')"
[ "$actual_bytes" = "$archive_bytes" ] ||
  fail "winflexbison archive size mismatch: expected $archive_bytes, got $actual_bytes"
actual_sha256="$(sha256_file "$archive")"
[ "$actual_sha256" = "$archive_sha256" ] ||
  fail "winflexbison archive checksum mismatch: expected $archive_sha256, got $actual_sha256"

"$extractor" \
  --archive "$archive" \
  --destination "$stage/payload" \
  --entry-count "$entry_count" \
  --required "$flex_path" \
  --required "$bison_path" \
  --required "data/README.md" \
  --executable "$flex_path" \
  --executable "$bison_path"
chmod -R u=rwX,go= "$stage/payload"
chmod u+x "$stage/payload/$flex_path" "$stage/payload/$bison_path"
printf '%s\n' "$receipt_text" >"$stage/receipt"
chmod u=r,go= "$stage/receipt"
cache_valid "$stage" || fail "staged winflexbison cache envelope failed integrity validation"

if [ -e "$final" ] || [ -L "$final" ]; then
  backup="$(mktemp -d "$parent/.windows-x64.backup.XXXXXX")"
  rmdir "$backup"
  mv "$final" "$backup"
  old_moved=1
fi
if [ "${OLIPHAUNT_WINFLEXBISON_TEST_INTERRUPT_AFTER_BACKUP:-0}" = "1" ]; then
  [ "${OLIPHAUNT_WINFLEXBISON_TESTING:-0}" = "1" ] ||
    fail "test interruption requires OLIPHAUNT_WINFLEXBISON_TESTING=1"
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
printf '%s\n' "$final/payload"

#!/usr/bin/env bash
set -euo pipefail
# The caller verifies the whole archive digest first and owns a private staging
# directory. Archive paths never become filesystem destinations here.
[ "$#" -ge 5 ] && [ "$#" -le 6 ] || { echo 'usage: extract-pinned-binary.sh FORMAT ARCHIVE MEMBER OUTPUT SHA256 [BYTES]' >&2; exit 2; }
format="$1" archive="$2" member="$3" output="$4" digest="$5" expected_bytes="${6:-}"
case "$member" in ''|/*|*'..'*|*'['*|*']'*|*'?'*|*'*'*|*'\'*) echo 'unsafe pinned member name' >&2; exit 2 ;; esac
[[ "$digest" =~ ^[0-9a-f]{64}$ ]] || exit 2
[[ "$expected_bytes" =~ ^[1-9][0-9]*$ || -z "$expected_bytes" ]] || exit 2
[ -f "$archive" ] && [ ! -L "$archive" ] || exit 2
[ ! -e "$output" ] && [ ! -L "$output" ] || exit 2
[ -d "$(dirname "$output")" ] && [ ! -L "$(dirname "$output")" ] || exit 2
limit="${expected_bytes:-150000000}"
[ "$limit" -le 250000000 ] || exit 2
success=0
trap '[ "$success" = 1 ] || rm -f "$output"' EXIT
set -C
read_member() {
  case "$format:$(uname -s)" in
    zip:MINGW*|zip:MSYS*|zip:CYGWIN*)
      env -u TAR_OPTIONS "$(cygpath -u "${SYSTEMROOT:-${SystemRoot:?Windows system directory is required}}")/System32/tar.exe" -xOf "$archive" -- "$member" ;;
    zip:*) env -u UNZIP -u UNZIPOPT unzip -p "$archive" "$member" ;;
    tar.xz:*|tar.gz:*) env -u TAR_OPTIONS tar -xOf "$archive" -- "$member" ;;
    *) echo "unsupported pinned archive format: $format" >&2; return 2 ;;
  esac
}
read_member | head -c "$((limit + 1))" > "$output"
bytes="$(wc -c < "$output" | tr -d '[:space:]')"
[ "$bytes" -gt 0 ] && [ "$bytes" -le "$limit" ] || exit 1
[ -z "$expected_bytes" ] || [ "$bytes" = "$expected_bytes" ] || exit 1
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$output" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$output" | awk '{print $1}')"
fi
[ "$actual" = "$digest" ] || { echo 'pinned executable checksum mismatch' >&2; exit 1; }
chmod 0555 "$output"
success=1

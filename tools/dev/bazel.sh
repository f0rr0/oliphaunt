#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$script_dir/../.." && pwd)"
cd "$root"

fail() {
  echo "bazel.sh: $*" >&2
  exit 1
}

[ -f .bazelversion ] || fail "missing $root/.bazelversion"
version="$(tr -d '\r' < .bazelversion)"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "invalid stable Bazel version: $version"

# Windows requires Git Bash/MSYS2; these selectors do not claim native PowerShell support.
platform="$(uname -s)/$(uname -m)"
case "$platform" in
  Linux/x86_64) suffix=linux-x86_64 ;;
  Linux/aarch64|Linux/arm64) suffix=linux-arm64 ;;
  Darwin/x86_64) suffix=darwin-x86_64 ;;
  Darwin/arm64|Darwin/aarch64) suffix=darwin-arm64 ;;
  MINGW*/x86_64|MSYS*/x86_64) suffix=windows-x86_64.exe ;;
  *) fail "unsupported bootstrap platform: $platform" ;;
esac
asset="bazel-$version-$suffix"
expected="$(awk -v version="$version" -v asset="$asset" \
  '$1 == version && $2 == asset { print $3 }' "$script_dir/bazel-checksums.tsv")"
[[ "$expected" =~ ^[0-9a-f]{64}$ ]] || fail "missing or ambiguous checksum for $asset"

if command -v sha256sum >/dev/null 2>&1; then
  digest() { sha256sum "$1" | awk '{ print $1 }'; }
elif command -v shasum >/dev/null 2>&1; then
  digest() { shasum -a 256 "$1" | awk '{ print $1 }'; }
else
  fail "bootstrap requires sha256sum or shasum"
fi

cache_dir="${XDG_CACHE_HOME:-${HOME:?set HOME or XDG_CACHE_HOME}/.cache}/oliphaunt/bazel/$version"
binary="$cache_dir/$asset"
if [ -f "$binary" ] && [ -x "$binary" ] && [ "$(digest "$binary")" = "$expected" ]; then
  exec "$binary" "$@"
fi

command -v curl >/dev/null 2>&1 || fail "bootstrap requires curl"
mkdir -p "$cache_dir"
download="$(mktemp "$cache_dir/.download.XXXXXX")"
trap 'rm -f "$download"' EXIT
# shellcheck source=tools/dev/acquisition.sh
. "$script_dir/acquisition.sh"
oliphaunt_acquisition_start "Bazel $version" 300
echo "Downloading pinned Bazel $version ($suffix)" >&2
oliphaunt_acquisition_curl 300 3 2 curl \
  --fail --location --silent --show-error --connect-timeout 15 \
  --proto '=https' --proto-redir '=https' \
  --output "$download" "https://releases.bazel.build/$version/release/$asset"
[ "$(digest "$download")" = "$expected" ] || fail "download checksum mismatch for $asset"
chmod +x "$download"
mv -f "$download" "$binary"
trap - EXIT
exec "$binary" "$@"

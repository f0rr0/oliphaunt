#!/usr/bin/env bash
set -euo pipefail

ACTIONLINT_VERSION="${ACTIONLINT_VERSION:-1.7.12}"

cargo_bin_dir="${CARGO_HOME:-$HOME/.cargo}/bin"
mkdir -p "$cargo_bin_dir"
PATH="$cargo_bin_dir:$PATH"
export PATH

version_output_matches() {
  output="$1"
  version="$2"
  escaped_version="$(printf '%s' "$version" | sed 's/[][\\.^$*+?{}|()]/\\&/g')"
  printf '%s\n' "$output" | grep -Eq "(^|[^0-9.])${escaped_version}([^0-9.]|$)"
}

require_pinned_version() {
  binary="$1"
  version="$2"
  output="$3"
  if ! version_output_matches "$output" "$version"; then
    cat >&2 <<MSG
$binary is installed, but it is not the pinned version.

Expected: $version
Found:
$output

Re-run tools/dev/bootstrap-tools.sh so the pinned local toolchain can replace
or override the mismatched binary.
MSG
    exit 1
  fi
}

local_binary="$cargo_bin_dir/actionlint"
if [ -x "$local_binary" ]; then
  output="$("$local_binary" -version 2>/dev/null || true)"
  if version_output_matches "$output" "$ACTIONLINT_VERSION"; then
    echo "actionlint already installed: $output"
    exit 0
  fi
  printf '%s\n' "replacing $local_binary with pinned actionlint@$ACTIONLINT_VERSION (found: $output)"
elif command -v actionlint >/dev/null 2>&1; then
  printf '%s\n' "installing pinned actionlint@$ACTIONLINT_VERSION; ignoring non-local actionlint at $(command -v actionlint)"
fi

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$os:$arch" in
  darwin:arm64) asset_os=darwin; asset_arch=arm64 ;;
  darwin:x86_64) asset_os=darwin; asset_arch=amd64 ;;
  linux:aarch64 | linux:arm64) asset_os=linux; asset_arch=arm64 ;;
  linux:x86_64) asset_os=linux; asset_arch=amd64 ;;
  *)
    echo "unsupported actionlint platform: $os/$arch" >&2
    echo "install actionlint manually from https://github.com/rhysd/actionlint/releases" >&2
    exit 1
    ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
archive="$tmp/actionlint.tar.gz"
if curl -L --fail --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 20 \
  --output "$archive" \
  "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_${asset_os}_${asset_arch}.tar.gz"; then
  tar -xzf "$archive" -C "$tmp"
  install "$tmp/actionlint" "$local_binary"
elif command -v go >/dev/null 2>&1; then
  printf '%s\n' "actionlint release asset download failed; falling back to go install"
  mkdir -p "$tmp/gobin"
  GOBIN="$tmp/gobin" go install "github.com/rhysd/actionlint/cmd/actionlint@v${ACTIONLINT_VERSION}"
  install "$tmp/gobin/actionlint" "$local_binary"
else
  echo "failed to download actionlint and Go is not available for source fallback" >&2
  exit 1
fi
output="$("$local_binary" -version 2>/dev/null || true)"
require_pinned_version actionlint "$ACTIONLINT_VERSION" "$output"

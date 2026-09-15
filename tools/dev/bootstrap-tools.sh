#!/usr/bin/env bash
set -euo pipefail

PREK_VERSION="${PREK_VERSION:-0.4.3}"
CARGO_NEXTEST_VERSION="${CARGO_NEXTEST_VERSION:-0.9.137}"
ZIZMOR_VERSION="${ZIZMOR_VERSION:-1.25.2}"

case "${1:-}" in
  ""|--workflows) ;;
  *) echo "usage: bootstrap-tools.sh [--workflows]" >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { echo "usage: bootstrap-tools.sh [--workflows]" >&2; exit 2; }

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cargo_bin_dir="${CARGO_HOME:-$HOME/.cargo}/bin"
mkdir -p "$cargo_bin_dir"
PATH="$cargo_bin_dir:$PATH"
export PATH

installed_tool_version() {
  binary="$1"
  case "$(basename "$binary")" in
    cargo-binstall) "$binary" -V 2>/dev/null || true ;;
    *) "$binary" --version 2>/dev/null || true ;;
  esac
}

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

installed_pinned_tool_version() {
  binary="$1"
  version="$2"
  output="$(installed_tool_version "$binary")"
  require_pinned_version "$binary" "$version" "$output"
  printf '%s\n' "$output"
}

install_cargo_tool() {
  package="$1"
  binary="$2"
  version="$3"
  local_binary="$cargo_bin_dir/$binary"
  if [ -x "$local_binary" ]; then
    output="$(installed_tool_version "$local_binary")"
    if version_output_matches "$output" "$version"; then
      echo "$binary already installed: $output"
      return
    fi
    printf '%s\n' "replacing $local_binary with pinned $package@$version (found: $output)"
  elif command -v "$binary" >/dev/null 2>&1; then
    printf '%s\n' "installing pinned $package@$version; ignoring non-local $binary at $(command -v "$binary")"
  fi

  if cargo binstall --no-confirm --disable-telemetry --force --strategies crate-meta-data,quick-install "$package@$version"; then
    installed_pinned_tool_version "$local_binary" "$version" >/dev/null
    return
  fi
  echo "cargo-binstall could not install $package@$version from a binary; falling back to cargo install" >&2
  cargo install "$package" --version "$version" --locked --force
  installed_pinned_tool_version "$local_binary" "$version" >/dev/null
}

install_cargo_binstall() {
  installer="$script_dir/install-pinned-maintainer-tool.sh"
  pinned_version="$("$installer" cargo-binstall --print-version)"
  if "$installer" cargo-binstall; then
    return
  else
    binary_status=$?
  fi
  case "$binary_status" in
    69 | 75) ;;
    *) return "$binary_status" ;;
  esac
  echo "cargo-binstall binary bootstrap was unavailable; building exact cargo-binstall@$pinned_version with Cargo.lock enforced" >&2
  (
    source_root="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-cargo-binstall-source.XXXXXX")"
    trap 'rm -rf "$source_root"' EXIT HUP INT TERM
    CARGO_HTTP_TIMEOUT="${CARGO_HTTP_TIMEOUT:-120}" \
      CARGO_NET_RETRY="${CARGO_NET_RETRY:-4}" \
      cargo install cargo-binstall \
        --version "$pinned_version" \
        --locked \
        --root "$source_root"
    "$installer" cargo-binstall --promote-locked-cargo-source "$source_root/bin/cargo-binstall"
  )
}

install_cargo_binstall
if [ "${OLIPHAUNT_BOOTSTRAP_CARGO_BINSTALL_ONLY:-0}" = 1 ]; then
  exit 0
fi
if [ "${1:-}" != --workflows ]; then
  install_cargo_tool prek prek "$PREK_VERSION"
  install_cargo_tool cargo-nextest cargo-nextest "$CARGO_NEXTEST_VERSION"
fi
install_cargo_tool zizmor zizmor "$ZIZMOR_VERSION"
"$script_dir/install-actionlint.sh"

echo "Tool bootstrap complete. Ensure $cargo_bin_dir is on PATH."

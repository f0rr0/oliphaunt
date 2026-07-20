#!/usr/bin/env bash
set -euo pipefail

PREK_VERSION="${PREK_VERSION:-0.4.3}"
CARGO_DENY_VERSION="${CARGO_DENY_VERSION:-0.19.8}"
CARGO_HACK_VERSION="${CARGO_HACK_VERSION:-0.6.44}"
CARGO_NEXTEST_VERSION="${CARGO_NEXTEST_VERSION:-0.9.137}"
CARGO_SEMVER_CHECKS_VERSION="${CARGO_SEMVER_CHECKS_VERSION:-0.47.0}"
DPRINT_VERSION="${DPRINT_VERSION:-0.54.0}"
LYCHEE_VERSION="${LYCHEE_VERSION:-0.24.2}"
TAPLO_VERSION="${TAPLO_VERSION:-0.10.0}"
TYPOS_VERSION="${TYPOS_VERSION:-1.47.0}"
ZIZMOR_VERSION="${ZIZMOR_VERSION:-1.25.2}"
RIPGREP_VERSION="${RIPGREP_VERSION:-15.1.0}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cargo_bin_dir="${CARGO_HOME:-$HOME/.cargo}/bin"
mkdir -p "$cargo_bin_dir"
PATH="$cargo_bin_dir:$PATH"
export PATH

has_command() {
  command -v "$1" >/dev/null 2>&1
}

installed_tool_version() {
  binary="$1"
  case "$(basename "$binary")" in
    cargo-binstall) "$binary" -V 2>/dev/null || true ;;
    cargo-hack) PATH="$(dirname "$binary"):$PATH" cargo hack --version 2>/dev/null || true ;;
    cargo-semver-checks) PATH="$(dirname "$binary"):$PATH" cargo semver-checks --version 2>/dev/null || true ;;
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
  install_mode="${4:-binary-first}"
  case "$install_mode" in
    binary-first | source-only) ;;
    *) echo "unsupported Cargo tool install mode: $install_mode" >&2; return 2 ;;
  esac
  local_binary="$cargo_bin_dir/$binary"
  if [ -x "$local_binary" ]; then
    output="$(installed_tool_version "$local_binary")"
    if version_output_matches "$output" "$version"; then
      echo "$binary already installed: $output"
      return
    fi
    printf '%s\n' "replacing $local_binary with pinned $package@$version (found: $output)"
  elif has_command "$binary"; then
    printf '%s\n' "installing pinned $package@$version; ignoring non-local $binary at $(command -v "$binary")"
  fi

  if [ "$install_mode" = binary-first ] && has_command cargo-binstall; then
    binstall_args="--no-confirm --disable-telemetry --force --strategies crate-meta-data,quick-install"
    if ! cargo binstall --help 2>/dev/null | grep -q -- '--force'; then
      binstall_args="--no-confirm --disable-telemetry --strategies crate-meta-data,quick-install"
    fi
    # shellcheck disable=SC2086
    if cargo binstall $binstall_args "$package@$version"; then
      installed_pinned_tool_version "$local_binary" "$version" >/dev/null
      return
    fi
    echo "cargo-binstall could not install $package@$version from a binary; falling back to cargo install" >&2
  elif [ "$install_mode" = source-only ]; then
    echo "installing pinned $package@$version from its locked crate source (no declared binary asset)"
  fi
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
install_cargo_tool prek prek "$PREK_VERSION"
install_cargo_tool cargo-deny cargo-deny "$CARGO_DENY_VERSION"
install_cargo_tool cargo-hack cargo-hack "$CARGO_HACK_VERSION"
install_cargo_tool cargo-nextest cargo-nextest "$CARGO_NEXTEST_VERSION"
install_cargo_tool cargo-semver-checks cargo-semver-checks "$CARGO_SEMVER_CHECKS_VERSION"
install_cargo_tool dprint dprint "$DPRINT_VERSION"
install_cargo_tool lychee lychee "$LYCHEE_VERSION"
# taplo-cli 0.10.0 has no cargo-quickinstall asset. Its binary-first path is a
# guaranteed 404 followed by this same locked source build, so skip the probe.
install_cargo_tool taplo-cli taplo "$TAPLO_VERSION" source-only
install_cargo_tool typos-cli typos "$TYPOS_VERSION"
install_cargo_tool zizmor zizmor "$ZIZMOR_VERSION"
install_cargo_tool ripgrep rg "$RIPGREP_VERSION"
"$script_dir/install-actionlint.sh"

echo
echo "Tool bootstrap complete. Ensure $cargo_bin_dir is on PATH."

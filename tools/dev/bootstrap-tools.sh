#!/usr/bin/env bash
set -euo pipefail

PREK_VERSION="${PREK_VERSION:-0.4.3}"
CARGO_BINSTALL_VERSION="${CARGO_BINSTALL_VERSION:-1.19.1}"
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

  binstall_args="--no-confirm --disable-telemetry --force --strategies crate-meta-data,quick-install"
  if ! cargo binstall --help 2>/dev/null | grep -q -- '--force'; then
    binstall_args="--no-confirm --disable-telemetry --strategies crate-meta-data,quick-install"
  fi
  if has_command cargo-binstall; then
    # shellcheck disable=SC2086
    if cargo binstall $binstall_args "$package@$version"; then
      installed_pinned_tool_version "$local_binary" "$version" >/dev/null
      return
    fi
    echo "cargo-binstall could not install $package@$version from a binary; falling back to cargo install" >&2
  fi
  cargo install "$package" --version "$version" --locked --force
  installed_pinned_tool_version "$local_binary" "$version" >/dev/null
}

install_cargo_binstall() {
  local_binary="$cargo_bin_dir/cargo-binstall"
  if [ -x "$local_binary" ]; then
    output="$(installed_tool_version "$local_binary")"
    if version_output_matches "$output" "$CARGO_BINSTALL_VERSION"; then
      echo "cargo-binstall already installed: $output"
      return
    fi
    printf '%s\n' "replacing $local_binary with pinned cargo-binstall@$CARGO_BINSTALL_VERSION (found: $output)"
  elif has_command cargo-binstall; then
    printf '%s\n' "installing pinned cargo-binstall@$CARGO_BINSTALL_VERSION; ignoring non-local cargo-binstall at $(command -v cargo-binstall)"
  fi

  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os:$arch" in
    darwin:arm64) asset="cargo-binstall-aarch64-apple-darwin.zip"; extract=zip ;;
    darwin:x86_64) asset="cargo-binstall-x86_64-apple-darwin.zip"; extract=zip ;;
    linux:aarch64 | linux:arm64) asset="cargo-binstall-aarch64-unknown-linux-musl.tgz"; extract=tgz ;;
    linux:x86_64) asset="cargo-binstall-x86_64-unknown-linux-musl.tgz"; extract=tgz ;;
    *)
      echo "unsupported cargo-binstall platform: $os/$arch" >&2
      echo "falling back to source-built cargo-installed tools" >&2
      return 0
      ;;
  esac

  tmp="$(mktemp -d)"
  archive="$tmp/$asset"
  url="https://github.com/cargo-bins/cargo-binstall/releases/download/v${CARGO_BINSTALL_VERSION}/${asset}"
  if ! curl -L --fail --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 20 --output "$archive" "$url"; then
    echo "cargo-binstall download failed; falling back to cargo install cargo-binstall@$CARGO_BINSTALL_VERSION" >&2
    rm -rf "$tmp"
    cargo install cargo-binstall --version "$CARGO_BINSTALL_VERSION" --locked --force
    installed_pinned_tool_version "$local_binary" "$CARGO_BINSTALL_VERSION" >/dev/null
    return
  fi
  case "$extract" in
    zip)
      command -v unzip >/dev/null 2>&1 || {
        echo "missing required command: unzip" >&2
        return 1
      }
      unzip -q "$archive" -d "$tmp"
      ;;
    tgz)
      tar -xzf "$archive" -C "$tmp"
      ;;
  esac
  binstall_bin="$(find "$tmp" -type f -name cargo-binstall | head -n 1)"
  if [ -z "$binstall_bin" ]; then
    echo "cargo-binstall archive did not contain a cargo-binstall binary" >&2
    find "$tmp" -maxdepth 3 -type f -print >&2
    return 1
  fi
  install "$binstall_bin" "$local_binary"
  rm -rf "$tmp"
  output="$(installed_tool_version "$local_binary")"
  require_pinned_version cargo-binstall "$CARGO_BINSTALL_VERSION" "$output"
}

install_cargo_binstall
install_cargo_tool prek prek "$PREK_VERSION"
install_cargo_tool cargo-deny cargo-deny "$CARGO_DENY_VERSION"
install_cargo_tool cargo-hack cargo-hack "$CARGO_HACK_VERSION"
install_cargo_tool cargo-nextest cargo-nextest "$CARGO_NEXTEST_VERSION"
install_cargo_tool cargo-semver-checks cargo-semver-checks "$CARGO_SEMVER_CHECKS_VERSION"
install_cargo_tool dprint dprint "$DPRINT_VERSION"
install_cargo_tool lychee lychee "$LYCHEE_VERSION"
install_cargo_tool taplo-cli taplo "$TAPLO_VERSION"
install_cargo_tool typos-cli typos "$TYPOS_VERSION"
install_cargo_tool zizmor zizmor "$ZIZMOR_VERSION"
install_cargo_tool ripgrep rg "$RIPGREP_VERSION"
"$script_dir/install-actionlint.sh"

echo
echo "Tool bootstrap complete. Ensure $cargo_bin_dir is on PATH."

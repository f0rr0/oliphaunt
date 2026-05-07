#!/usr/bin/env bash
set -euo pipefail

PREK_VERSION="${PREK_VERSION:-0.3.10}"
CARGO_BINSTALL_VERSION="${CARGO_BINSTALL_VERSION:-1.19.1}"
CARGO_DENY_VERSION="${CARGO_DENY_VERSION:-0.19.4}"
CARGO_HACK_VERSION="${CARGO_HACK_VERSION:-0.6.44}"
CARGO_SEMVER_CHECKS_VERSION="${CARGO_SEMVER_CHECKS_VERSION:-0.47.0}"
ZIZMOR_VERSION="${ZIZMOR_VERSION:-1.24.1}"
ACTIONLINT_VERSION="${ACTIONLINT_VERSION:-1.7.12}"

cargo_bin_dir="${CARGO_HOME:-$HOME/.cargo}/bin"
mkdir -p "$cargo_bin_dir"
PATH="$cargo_bin_dir:$PATH"
export PATH

has_command() {
  command -v "$1" >/dev/null 2>&1
}

installed_tool_version() {
  binary="$1"
  case "$binary" in
    cargo-hack) cargo hack --version 2>/dev/null || true ;;
    cargo-semver-checks) cargo semver-checks --version 2>/dev/null || true ;;
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

Remove or update the existing $binary so scripts/bootstrap-tools.sh can provide
the pinned toolchain.
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
  if has_command "$binary"; then
    echo "$binary already installed: $(installed_pinned_tool_version "$binary" "$version")"
    return
  fi
  if has_command cargo-binstall; then
    if cargo binstall \
      --no-confirm \
      --disable-telemetry \
      --strategies crate-meta-data,quick-install \
      "$package@$version"; then
      installed_pinned_tool_version "$binary" "$version" >/dev/null
      return
    fi
    echo "cargo-binstall could not install $package@$version from a binary; falling back to cargo install" >&2
  fi
  cargo install "$package" --version "$version" --locked
  installed_pinned_tool_version "$binary" "$version" >/dev/null
}

install_cargo_binstall() {
  if has_command cargo-binstall; then
    output="$(cargo-binstall -V 2>/dev/null || true)"
    require_pinned_version cargo-binstall "$CARGO_BINSTALL_VERSION" "$output"
    echo "cargo-binstall already installed: $output"
    return
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
  curl -L --fail --retry 3 --output "$archive" "$url"
  case "$extract" in
    zip)
      python3 - "$archive" "$tmp" <<'PY'
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    archive.extractall(sys.argv[2])
PY
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
  install "$binstall_bin" "$cargo_bin_dir/cargo-binstall"
  rm -rf "$tmp"
  output="$(cargo-binstall -V 2>/dev/null || true)"
  require_pinned_version cargo-binstall "$CARGO_BINSTALL_VERSION" "$output"
}

install_actionlint() {
  if has_command actionlint; then
    output="$(actionlint -version 2>/dev/null || true)"
    require_pinned_version actionlint "$ACTIONLINT_VERSION" "$output"
    echo "actionlint already installed: $output"
    return
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
      return 1
      ;;
  esac

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  archive="$tmp/actionlint.tar.gz"
  curl -L --fail --retry 3 \
    --output "$archive" \
    "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_${asset_os}_${asset_arch}.tar.gz"
  tar -xzf "$archive" -C "$tmp"
  install "$tmp/actionlint" "$cargo_bin_dir/actionlint"
  output="$(actionlint -version 2>/dev/null || true)"
  require_pinned_version actionlint "$ACTIONLINT_VERSION" "$output"
}

install_cargo_binstall
install_cargo_tool prek prek "$PREK_VERSION"
install_cargo_tool cargo-deny cargo-deny "$CARGO_DENY_VERSION"
install_cargo_tool cargo-hack cargo-hack "$CARGO_HACK_VERSION"
install_cargo_tool cargo-semver-checks cargo-semver-checks "$CARGO_SEMVER_CHECKS_VERSION"
install_cargo_tool zizmor zizmor "$ZIZMOR_VERSION"
install_actionlint

echo
echo "Tool bootstrap complete. Ensure $cargo_bin_dir is on PATH."

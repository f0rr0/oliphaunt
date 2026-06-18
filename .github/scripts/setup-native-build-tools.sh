#!/usr/bin/env bash
set -euo pipefail

ccache_max_size="${1:-2G}"
enable_ccache=1

install_macos_tools() {
  local missing_packages=()

  require_brew_tool() {
    local command_name="$1"
    local package_name="$2"
    if ! command -v "$command_name" >/dev/null 2>&1; then
      missing_packages+=("$package_name")
    fi
  }

  require_brew_tool ccache ccache
  require_brew_tool autoconf autoconf
  require_brew_tool aclocal automake
  require_brew_tool glibtoolize libtool

  if ((${#missing_packages[@]} > 0)); then
    HOMEBREW_NO_AUTO_UPDATE=1 brew install "${missing_packages[@]}"
  fi
}

install_linux_tools() {
  .github/scripts/prepare-linux-apt.sh
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    ccache \
    cmake \
    curl \
    git \
    make \
    perl \
    pkg-config \
    ripgrep \
    rsync \
    sqlite3 \
    xz-utils
}

install_choco_package() {
  local package="$1"
  local attempt
  for attempt in 1 2 3; do
    if choco install -y "$package" --no-progress --limit-output; then
      return 0
    fi
    if [ "$attempt" -lt 3 ]; then
      sleep $((attempt * 15))
    fi
  done
  return 1
}

windows_path_for_command() {
  local command_name="$1"
  local candidate
  candidate="$(cmd.exe /C "where $command_name" 2>/dev/null | tr -d '\r' | head -n 1 || true)"
  if [ -n "$candidate" ] && command -v cygpath >/dev/null 2>&1; then
    candidate="$(cygpath -u "$candidate")"
  fi
  printf '%s\n' "$candidate"
}

find_winflex_dir() {
  local candidate
  for candidate in \
    /c/ProgramData/chocolatey/lib/winflexbison3/tools \
    /c/tools/winflexbison3; do
    if [ -x "$candidate/win_flex.exe" ] && [ -x "$candidate/win_bison.exe" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  candidate="$(windows_path_for_command win_flex.exe)"
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    candidate="$(dirname "$candidate")"
    if [ -x "$candidate/win_bison.exe" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi
  return 1
}

install_windows_tools() {
  python -m pip install --user meson==1.10.0 ninja==1.13.0
  if [ ! -x /c/Strawberry/perl/bin/perl.exe ]; then
    install_choco_package strawberryperl
  fi
  local winflex_dir=""
  winflex_dir="$(find_winflex_dir || true)"
  if [ -z "$winflex_dir" ]; then
    install_choco_package winflexbison3
    winflex_dir="$(find_winflex_dir || true)"
  fi
  if [ -z "$winflex_dir" ]; then
    echo "setup-native-build-tools.sh: missing win_flex.exe and win_bison.exe from winflexbison3" >&2
    exit 1
  fi
  export PATH="$winflex_dir:$PATH"
  if [ -n "${GITHUB_PATH:-}" ]; then
    if command -v cygpath >/dev/null 2>&1; then
      cygpath -w "$winflex_dir" >>"$GITHUB_PATH"
    else
      printf '%s\n' "$winflex_dir" >>"$GITHUB_PATH"
    fi
  fi
  enable_ccache=0
}

case "$(uname -s)" in
  Darwin)
    install_macos_tools
    ;;
  Linux)
    install_linux_tools
    ;;
  MINGW* | MSYS* | CYGWIN*)
    install_windows_tools
    ;;
  *)
    ;;
esac

if [ "$enable_ccache" = "1" ] && command -v ccache >/dev/null 2>&1; then
  ccache --max-size="$ccache_max_size"
  if [ "${OLIPHAUNT_CCACHE_ZERO_STATS:-0}" = "1" ]; then
    ccache --zero-stats
  fi
fi

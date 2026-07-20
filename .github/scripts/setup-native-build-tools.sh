#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
ccache_max_size="${1:-${OLIPHAUNT_CCACHE_MAX_SIZE:-2G}}"
enable_ccache=1

install_macos_tools() {
  local missing_packages=()

  .github/scripts/prepare-macos-homebrew.sh

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
    local attempt
    for attempt in 1 2 3; do
      if HOMEBREW_NO_AUTO_UPDATE=1 brew install "${missing_packages[@]}"; then
        return 0
      fi
      if [ "$attempt" -lt 3 ]; then
        sleep $((attempt * 15))
      fi
    done
    echo "setup-native-build-tools.sh: Homebrew failed after 3 attempts" >&2
    return 1
  fi
}

install_linux_tools() {
  .github/scripts/prepare-linux-apt.sh
  sudo apt-get \
    -o Acquire::Retries=5 \
    -o Acquire::http::Timeout=30 \
    -o Acquire::https::Timeout=30 \
    update
  sudo apt-get \
    -o Acquire::Retries=5 \
    -o Acquire::http::Timeout=30 \
    -o Acquire::https::Timeout=30 \
    install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    ccache \
    cmake \
    curl \
    g++-12 \
    gcc-12 \
    git \
    make \
    perl \
    pkg-config \
    ripgrep \
    rsync \
    sqlite3 \
    xz-utils

  local linux_cc linux_cxx cc_major cxx_major
  linux_cc="$(readlink -f "$(command -v gcc-12)")"
  linux_cxx="$(readlink -f "$(command -v g++-12)")"
  cc_major="$("$linux_cc" -dumpfullversion -dumpversion | cut -d. -f1)"
  cxx_major="$("$linux_cxx" -dumpfullversion -dumpversion | cut -d. -f1)"
  if [ "$cc_major" != "12" ] || [ "$cxx_major" != "12" ]; then
    echo "setup-native-build-tools.sh: expected GCC/G++ major 12, got $cc_major/$cxx_major" >&2
    return 1
  fi

  export CC="$linux_cc"
  export CXX="$linux_cxx"
  export OLIPHAUNT_CC="$linux_cc"
  export OLIPHAUNT_CXX="$linux_cxx"
  if [ -n "${GITHUB_ENV:-}" ]; then
    {
      printf 'CC=%s\n' "$linux_cc"
      printf 'CXX=%s\n' "$linux_cxx"
      printf 'OLIPHAUNT_CC=%s\n' "$linux_cc"
      printf 'OLIPHAUNT_CXX=%s\n' "$linux_cxx"
    } >> "$GITHUB_ENV"
  fi
  printf 'Pinned Linux native compiler contract: %s / %s\n' \
    "$("$linux_cc" -dumpfullversion -dumpversion)" \
    "$("$linux_cxx" -dumpfullversion -dumpversion)"
}

install_choco_package() {
  local package="$1"
  local expected_executable="$2"
  local attempt
  for attempt in 1 2 3; do
    if choco install -y "$package" --no-progress --limit-output &&
      [ -x "$expected_executable" ]; then
      return 0
    fi
    if [ "$attempt" -lt 3 ]; then
      sleep $((attempt * 15))
    fi
  done
  echo "setup-native-build-tools.sh: Chocolatey did not install $expected_executable after 3 attempts" >&2
  return 1
}

install_windows_tools() {
  python -m pip install \
    --disable-pip-version-check \
    --retries 8 \
    --timeout 60 \
    --user \
    meson==1.10.0 \
    ninja==1.13.0
  if [ ! -x /c/Strawberry/perl/bin/perl.exe ]; then
    install_choco_package strawberryperl /c/Strawberry/perl/bin/perl.exe
  fi
  [ -x /c/Strawberry/perl/bin/perl.exe ] || {
    echo "setup-native-build-tools.sh: missing Strawberry Perl after verified installation" >&2
    return 1
  }
  local winflex_dir cache_root
  cache_root="${RUNNER_TEMP:-$repo_root/target}/oliphaunt-native-tools"
  winflex_dir="$(
    OLIPHAUNT_PINNED_NATIVE_TOOL_CACHE_ROOT="$cache_root" \
      bash "$repo_root/tools/dev/install-pinned-winflexbison.sh"
  )"
  [ -x "$winflex_dir/win_flex.exe" ] && [ -x "$winflex_dir/win_bison.exe" ] || {
    echo "setup-native-build-tools.sh: pinned winflexbison payload is incomplete" >&2
    return 1
  }
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
  if [ -n "${CCACHE_DIR:-}" ]; then
    mkdir -p "$CCACHE_DIR"
  fi
  ccache --max-size="$ccache_max_size"
  if [ "${OLIPHAUNT_CCACHE_ZERO_STATS:-0}" = "1" ]; then
    ccache --zero-stats
  fi
fi

#!/usr/bin/env bash
set -euo pipefail

if [[ "${RUNNER_OS:-}" != "Linux" ]]; then
  exit 0
fi

echo "Disk before Android mobile cleanup:"
df -h "${GITHUB_WORKSPACE:-.}"

sudo rm -rf \
  /opt/ghc \
  /opt/hostedtoolcache/CodeQL \
  /usr/local/share/boost \
  /usr/share/dotnet

if [[ -n "${ANDROID_HOME:-}" && -d "$ANDROID_HOME" ]]; then
  sudo rm -rf \
    "$ANDROID_HOME/emulator" \
    "$ANDROID_HOME/system-images"
fi

echo "Disk after Android mobile cleanup:"
df -h "${GITHUB_WORKSPACE:-.}"

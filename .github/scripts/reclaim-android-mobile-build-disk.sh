#!/usr/bin/env bash
set -euo pipefail
[ "${RUNNER_OS:-}" = Linux ] || exit 0
workspace="${GITHUB_WORKSPACE:-.}"
printf 'Disk before Android mobile cleanup:\n'
df -h "$workspace"
sudo rm -rf /opt/ghc /opt/hostedtoolcache/CodeQL /usr/local/share/boost /usr/share/dotnet
if [ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME" ]; then
  sudo rm -rf "$ANDROID_HOME/emulator" "$ANDROID_HOME/system-images"
fi
printf 'Disk after Android mobile cleanup:\n'
df -h "$workspace"

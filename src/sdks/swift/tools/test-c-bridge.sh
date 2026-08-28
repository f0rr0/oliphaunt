#!/usr/bin/env sh
set -eu

root="$(git rev-parse --show-toplevel)"
host_os="$(uname -s)"
case "$host_os" in
  MINGW*|MSYS*|CYGWIN*)
    echo "Swift C bridge unit tests are covered by the Linux/macOS lanes"
    exit 0
    ;;
esac

scratch="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-swift-c-bridge.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

set --
if [ "$host_os" != "Darwin" ]; then
  set -- -ldl
fi

"${CC:-cc}" \
  -std=c11 \
  -Wall \
  -Wextra \
  -Werror \
  -D_POSIX_C_SOURCE=200809L \
  -pthread \
  -I "$root/src/sdks/swift/Sources/COliphaunt/include" \
  "$root/src/sdks/swift/tools/bridge-mutex-init-failure.c" \
  "$@" \
  -o "$scratch/bridge-mutex-init-failure"

"$scratch/bridge-mutex-init-failure"

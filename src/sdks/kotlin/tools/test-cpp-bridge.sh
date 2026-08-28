#!/usr/bin/env sh
set -eu

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cxx="${CXX:-c++}"
if ! command -v "$cxx" >/dev/null 2>&1; then
  echo "missing required C++ compiler: $cxx" >&2
  exit 1
fi

scratch="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-kotlin-cpp-bridge.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

"$cxx" \
  -std=c++17 \
  -Wall \
  -Wextra \
  -Werror \
  -Wpedantic \
  -I "$root/src/sdks/kotlin/oliphaunt/src/androidMain/cpp" \
  -I "$root/src/sdks/kotlin/oliphaunt/src/androidMain/cpp/include" \
  "$root/src/sdks/kotlin/tools/android-stream-completion-test.cpp" \
  -o "$scratch/android-stream-completion-test"

"$scratch/android-stream-completion-test"

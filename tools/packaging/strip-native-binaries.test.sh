#!/usr/bin/env bash
set -euo pipefail
[ "$(uname -s)" = Linux ] || { echo 'ELF strip execution requires Linux'; exit 0; }
script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/strip-native-binaries.sh"
work="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-native-strip.XXXXXX")"
trap 'rm -rf "$work"' EXIT
cd "$work"
printf 'int answer(void) { return 42; }\n' >probe.c
printf 'extern int answer(void); int main(void) { return answer() != 42; }\n' >main.c
cc -g -fPIC -shared probe.c -o libprobe.so
cc -g main.c -L. -lprobe -Wl,-rpath,"$work" -o consumer
cc -g -c probe.c -o probe.o
ar cr libprobe.a probe.o
cp libprobe.a preserved.lib
cp preserved.lib before.lib
cp libprobe.so before.so
if bash "$script" libprobe.so missing-input >/dev/null 2>&1; then exit 1; fi
cmp before.so libprobe.so
rm before.so
before="$(wc -c <libprobe.so)"
nm -D --defined-only libprobe.so >symbols.before
bash "$script" --target linux-x64-gnu libprobe.so consumer libprobe.a preserved.lib
[ "$(wc -c <libprobe.so)" -lt "$before" ]
nm -D --defined-only libprobe.so >symbols.after
cmp symbols.before symbols.after
cmp before.lib preserved.lib
./consumer
# Cross-compiled archives need the target's NDK tool, including on macOS hosts.
clang="$(command -v clang-22 || command -v clang || true)"
strip="$(command -v llvm-strip-22 || command -v llvm-strip || true)"
if [ -n "$clang" ] && [ -n "$strip" ]; then
  "$clang" --target=aarch64-linux-gnu -g -c probe.c -o android.o
  ar cr android.a android.o
  mkdir -p ndk/toolchains/llvm/prebuilt/linux-x86_64/bin
  ln -s "$strip" ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip
  before="$(wc -c <android.a)"
  ANDROID_NDK_HOME="$work/ndk" OLIPHAUNT_ELF_STRIP= OLIPHAUNT_STRIP= OLIPHAUNT_ANDROID_STRIP= bash "$script" --target android-arm64-v8a android.a
  [ "$(wc -c <android.a)" -lt "$before" ]
fi
printf 'Native stripping preserved exported behavior, static symbols, and import libraries.\n'

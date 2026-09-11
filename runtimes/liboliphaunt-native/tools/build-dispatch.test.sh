#!/usr/bin/env bash
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-build-dispatch.XXXXXX")"
trap 'rm -rf "$fixture"' EXIT
cd "$fixture"
git init -q
owner=runtimes/liboliphaunt-native
mkdir -p "$owner/tools" "$owner/bin" third-party/postgres bin
cp "$root/$owner/tools/release-runtime.sh" "$root/$owner/tools/build-ci-target.sh" "$owner/tools/"
cp "$root/third-party/postgres/source.toml" third-party/postgres/
export PATH="$fixture/bin:$PATH" CAPTURE="$fixture/calls" TEST_HOST=Linux
cat > bin/uname <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$TEST_HOST"
STUB
cat > bin/bun <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$CAPTURE"
STUB
cat > bin/product-build <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s %s\n' "$(basename "$0")" "$*" >>"$CAPTURE"
if [ -n "${FAIL_BUILD:-}" ]; then exit 19; fi
if [ -n "${OLIPHAUNT_ANDROID_ARM64_ROOT:-}" ]; then mkdir -p "$OLIPHAUNT_ANDROID_ARM64_ROOT/out"; fi
if [ -n "${OLIPHAUNT_ANDROID_X86_64_ROOT:-}" ]; then mkdir -p "$OLIPHAUNT_ANDROID_X86_64_ROOT/out"; fi
host="${OLIPHAUNT_LINUX_WORK_ROOT:-${OLIPHAUNT_WORK_ROOT:-}}"
if [ -n "$host" ]; then mkdir -p "$host/install" "$host/icu/share/icu" "$host/out/modules"; printf library >"$host/install/library"; fi
case "$0" in *build-ios-xcframework.sh) mkdir -p target/liboliphaunt-ios-{device,simulator,xcframework}/out ;; esac
case "$0" in *package-*) printf '%s %s %s\n' "$OLIPHAUNT_LIBOLIPHAUNT_RELEASE_ASSETS" "$OLIPHAUNT_RELEASE_BUILD_RUNTIME" "$OLIPHAUNT_RELEASE_FETCH_ASSETS" >>"$CAPTURE" ;; esac
STUB
chmod +x bin/*
for name in build-postgres18-linux build-postgres18-macos build-postgres18-windows build-postgres18-android-arm64 build-postgres18-android-x86_64 build-ios-xcframework; do cp bin/product-build "$owner/bin/$name.sh"; done
for platform in linux macos windows; do cp bin/product-build "$owner/tools/package-liboliphaunt-$platform-assets.sh"; done
for target in android-arm64-v8a android-x86_64 ios-xcframework; do
  : >"$CAPTURE"
  bash "$owner/tools/build-ci-target.sh" "$target"
  test -f "target/liboliphaunt-native-ci/$target/target/liboliphaunt-mobile-host/$target/install/library"
  if [ "$target" = android-x86_64 ]; then
    ! grep -q -- '--runtime-only' "$CAPTURE"
    test -d "target/liboliphaunt-native-ci/$target/target/liboliphaunt-mobile-host/$target/out/modules"
  else grep -q -- '--runtime-only' "$CAPTURE"; fi
  if [ "$target" = ios-xcframework ]; then grep -q 'compare --domain ios-datum64' "$CAPTURE"; fi
done
for pair in Linux:linux-x64-gnu Darwin:macos-arm64 MINGW64_NT:windows-x64-msvc; do
  export TEST_HOST="${pair%%:*}" OLIPHAUNT_CI_TARGET="${pair#*:}"
  : >"$CAPTURE"
  bash "$owner/tools/release-runtime.sh" build
  bash "$owner/tools/release-runtime.sh" package
  if [ "$TEST_HOST" = MINGW64_NT ]; then
    grep -q 'build-postgres18-windows.sh' "$CAPTURE"
    if FAIL_BUILD=1 bash "$owner/tools/release-runtime.sh" build; then exit 1; else test "$?" = 19; fi
  fi
  grep -q "desktop-release-assets/$OLIPHAUNT_CI_TARGET 0 0" "$CAPTURE"
done
: >"$CAPTURE"
if TEST_HOST=Linux OLIPHAUNT_CI_TARGET=macos-arm64 bash "$owner/tools/release-runtime.sh" build; then exit 1; fi
test ! -s "$CAPTURE"
if FAIL_BUILD=1 TEST_HOST=Linux OLIPHAUNT_CI_TARGET=linux-x64-gnu bash "$owner/tools/release-runtime.sh" build; then exit 1; else test "$?" = 19; fi
printf 'Native build and package dispatch passed.\n'

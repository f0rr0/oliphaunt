#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
cd "$fixture"
git init -q
owner=runtimes/liboliphaunt-native
mkdir -p "$owner/tools" "$owner/include" "$owner/bin" tools/dev tools/packaging bin
cp "$root/$owner/tools/package-liboliphaunt-mobile-assets.sh" "$owner/tools/"
printf 'oliphaunt_assert_base_runtime_has_no_optional_extensions() { return 0; }\n' >"$owner/tools/liboliphaunt-extension-guard.sh"
export PATH="$fixture/bin:$PATH" CAPTURE="$fixture/calls"
cat >bin/bun <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  *product-version.mts) echo 1.2.3 ;;
  *native-mobile-abi-contract.mts)
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --output ]; then mkdir -p "$(dirname "$2")"; echo receipt >"$2"; break; fi
      shift
    done ;;
  *finalize-native-runtime-carrier.mts) printf '%s\n' "$*" >>"$CAPTURE" ;;
esac
STUB
cat >bin/cargo <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then mkdir -p "$2/oliphaunt/runtime/files"; break; fi
  shift
done
STUB
cat >bin/rsync <<'STUB'
#!/usr/bin/env bash
cp -R "$3" "$4"
STUB
printf '#!/usr/bin/env bash\nbun "$@"\n' >tools/dev/bun.sh
printf '#!/usr/bin/env bash\nexit 0\n' >tools/packaging/archive-directory.mts
cp tools/packaging/archive-directory.mts tools/packaging/strip-native-binaries.sh
cat >"$owner/bin/build-ios-xcframework.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
test -d "$OLIPHAUNT_MACOS_RUNTIME_RESOURCES_ROOT/runtime/files"
test -f "$OLIPHAUNT_IOS_RUNTIME_RESOURCES_ROOT/provenance/native-mobile-abi/ios-arm64.properties"
mkdir -p "$OLIPHAUNT_IOS_XCFRAMEWORK_ROOT/out/liboliphaunt.xcframework"
STUB
chmod +x bin/* tools/dev/* tools/packaging/* "$owner/bin/"*
mkdir -p target/liboliphaunt-ios-xcframework/out/liboliphaunt.xcframework target/liboliphaunt-pg18/install
bash "$owner/tools/package-liboliphaunt-mobile-assets.sh" ios-xcframework
grep -F -- '--target macos-arm64' "$CAPTURE"
grep -F -- '--target ios-datum64' "$CAPTURE"
echo 'iOS runtime resource packaging dispatch verified.'

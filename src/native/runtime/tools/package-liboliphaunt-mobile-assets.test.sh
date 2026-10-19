#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
cd "$fixture"
git init -q
owner=src/native/runtime
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
  if [ "$1" = --output ]; then
    mkdir -p "$2/oliphaunt/runtime/files/lib/postgresql"
    printf embedded >"$2/oliphaunt/runtime/files/lib/postgresql/dict_snowball.dylib"
    printf embedded >"$2/oliphaunt/runtime/files/lib/postgresql/plpgsql.dylib"
    break
  fi
  shift
done
STUB
cat >bin/install_name_tool <<'STUB'
#!/usr/bin/env bash
printf 'install_name_tool %s\n' "$*" >>"$CAPTURE"
STUB
cat >bin/otool <<'STUB'
#!/usr/bin/env bash
cat <<'OUTPUT'
Load command 1
          cmd LC_RPATH
      cmdsize 48
         path /tmp/oliphaunt build/lib (offset 12)
OUTPUT
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
test "$(cat "$OLIPHAUNT_MACOS_RUNTIME_RESOURCES_ROOT/runtime/files/lib/postgresql/dict_snowball.dylib")" = normal
test "$(cat "$OLIPHAUNT_MACOS_RUNTIME_RESOURCES_ROOT/runtime/files/lib/modules/dict_snowball.dylib")" = embedded
test -f "$OLIPHAUNT_IOS_RUNTIME_RESOURCES_ROOT/provenance/native-mobile-abi/ios-arm64.properties"
mkdir -p "$OLIPHAUNT_IOS_XCFRAMEWORK_ROOT/out/liboliphaunt.xcframework"
STUB
chmod +x bin/* tools/dev/* tools/packaging/* "$owner/bin/"*
mkdir -p \
  target/liboliphaunt-ios-xcframework/out/liboliphaunt.xcframework \
  target/liboliphaunt-pg18/install/lib/postgresql
printf normal >target/liboliphaunt-pg18/install/lib/postgresql/dict_snowball.dylib
printf normal >target/liboliphaunt-pg18/install/lib/postgresql/plpgsql.dylib
bash "$owner/tools/package-liboliphaunt-mobile-assets.sh" ios-xcframework
grep -F -- '--target macos-arm64' "$CAPTURE"
grep -F -- '--target ios-datum64' "$CAPTURE"
grep -F -- '-change @rpath/liboliphaunt.dylib @rpath/liboliphaunt.framework/liboliphaunt' "$CAPTURE"
grep -F -- '-delete_rpath /tmp/oliphaunt build/lib' "$CAPTURE"
echo 'iOS runtime resource packaging dispatch verified.'

#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
root="$PWD"
fail() { echo "package-liboliphaunt-windows-assets.sh: $*" >&2; exit 1; }
case "$(uname -s)" in MINGW*|MSYS*) ;; *) fail 'Windows release assets require Windows' ;; esac
source runtimes/liboliphaunt-native/tools/liboliphaunt-extension-guard.sh

version="$(bun tools/release/product-version.mts version liboliphaunt-native)"
target_id=windows-x64-msvc
out_dir="${OLIPHAUNT_LIBOLIPHAUNT_RELEASE_ASSETS:-$root/target/liboliphaunt/release-assets}"
work_root="${OLIPHAUNT_WINDOWS_WORK_ROOT:-${OLIPHAUNT_WORK_ROOT:-$root/target/liboliphaunt-pg18-$target_id}}"
# Native callers may supply drive-letter paths; normalize once for Git Bash tools.
out_dir="$(cygpath -u "$out_dir")"
work_root="$(cygpath -u "$work_root")"
stage_root="$root/target/liboliphaunt/release-stage-$target_id"
stage="$stage_root/liboliphaunt-$version-$target_id"
runtime="$work_root/install"
modules="$work_root/out/modules"
asset="$out_dir/liboliphaunt-$version-$target_id.zip"

if [ "${OLIPHAUNT_RELEASE_FETCH_ASSETS:-1}" != 0 ]; then
  bash third-party/tools/fetch-sources.sh native-runtime
fi
if [ "${OLIPHAUNT_RELEASE_BUILD_RUNTIME:-1}" != 0 ]; then
  OLIPHAUNT_CI_TARGET="$target_id" bash runtimes/liboliphaunt-native/tools/release-runtime.sh build
fi
for file in out/bin/oliphaunt.dll out/lib/oliphaunt.lib out/bin/icudt76.dll out/bin/icuin76.dll out/bin/icuuc76.dll install/bin/initdb.exe install/bin/pg_ctl.exe install/bin/postgres.exe; do
  [ -f "$work_root/$file" ] || fail "missing Windows build output $work_root/$file"
done
oliphaunt_assert_base_embedded_modules_exact "$modules" dll
rm -rf "$stage_root"
mkdir -p "$out_dir" "$stage"/{include,bin,lib/modules,runtime}
bun extensions/tools/native-extension-files.mts >"$stage_root/extension-catalog.tsv"
oliphaunt_assert_base_runtime_has_no_optional_extensions "$stage_root/extension-catalog.tsv" "$runtime"

cp -R runtimes/liboliphaunt-native/include/. "$stage/include/"
cp "$work_root/out/bin/oliphaunt.dll" "$work_root/out/bin/"{icudt76,icuin76,icuuc76}.dll "$stage/bin/"
cp "$work_root/out/lib/oliphaunt.lib" "$stage/lib/"
cp -R "$modules/." "$stage/lib/modules/"
cp -R "$runtime/." "$stage/runtime/"
bun tools/packaging/windows-vc-runtime-closure.mts stage \
  --root "$stage" --source-dir "$work_root/out/bin" --profile provider \
  --destination "$stage/bin" --destination "$stage/runtime/bin"
rm -f "$stage/runtime/bin/"{pg_basebackup,pg_dump,psql}.exe
rm -rf "$stage/runtime/share/icu"
bun runtimes/liboliphaunt-native/tools/native-runtime-payload.mts "$stage" --target "$target_id" --tool-set runtime
bash tools/packaging/strip-native-binaries.sh --target "$target_id" "$stage"
bun tools/packaging/platform-binary-contract.mts --target "$target_id" --root "$stage" \
  --require-windows-runtime-import-library --windows-vc-runtime-profile provider
bun tools/packaging/release-notices.mts stage "$stage" --profile native-runtime
bun tools/packaging/archive-directory.mts "$stage" "$asset"
bun tools/packaging/release-notices.mts check-archive "$asset" --profile native-runtime
echo "liboliphauntWindowsReleaseAsset=$asset"

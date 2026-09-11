#!/usr/bin/env bash
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"
. runtimes/liboliphaunt-native/tools/runtime-preflight.sh
target="${OLIPHAUNT_CI_TARGET:-}"
runtime=""
output="$root/target/postgres-tools/native/release-assets"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target) target="${2:?missing target}"; shift 2 ;;
    --runtime) runtime="${2:?missing runtime install directory}"; shift 2 ;;
    --output-dir) output="${2:?missing output directory}"; shift 2 ;;
    *) echo 'usage: package-assets.sh --target TARGET [--runtime INSTALL] [--output-dir DIR]' >&2; exit 2 ;;
  esac
done
target="${target:-$(oliphaunt_runtime_native_host_target_id)}"
case "$target" in
  linux-x64-gnu|linux-arm64-gnu)
    runtime="${runtime:-${OLIPHAUNT_LINUX_WORK_ROOT:-$root/target/liboliphaunt-pg18-$target}/install}"
    suffix=""; archive_suffix=tar.gz ;;
  macos-arm64)
    runtime="${runtime:-${OLIPHAUNT_WORK_ROOT:-$root/target/liboliphaunt-pg18}/install}"
    suffix=""; archive_suffix=tar.gz ;;
  windows-x64-msvc)
    runtime="${runtime:-${OLIPHAUNT_WINDOWS_WORK_ROOT:-${OLIPHAUNT_WORK_ROOT:-$root/target/liboliphaunt-pg18-$target}}/install}"
    suffix=.exe; archive_suffix=zip ;;
  *) echo "unsupported native tools target: $target" >&2; exit 2 ;;
esac
[ -d "$runtime" ] || { echo "missing PostgreSQL installation: $runtime" >&2; exit 1; }
version="$(tools/dev/bun.sh tools/release/product-version.mts version postgres-tools-native)"
mkdir -p "$output"
stage="$(mktemp -d "$output/.stage-$target.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/runtime/bin" "$stage/runtime/lib"
queue=()
for tool in pg_basebackup pg_dump psql; do
  cp -Lp "$runtime/bin/$tool$suffix" "$stage/runtime/bin/"
  queue+=("$stage/runtime/bin/$tool$suffix")
done

# Copy only dependencies present in the producer installation. OS libraries
# remain supplied by the supported host, never borrowed from another package.
imports() {
  case "$target" in
    linux-*) readelf -d "$1" | sed -n 's/.*(NEEDED).*\[\([^]]*\)\].*/\1/p' ;;
    macos-*) otool -L "$1" | sed '1d;s/^[[:space:]]*//;s/ (compatibility version.*//' ;;
    windows-*) tools/dev/bun.sh - "$1" <<'TS'
import { readFileSync } from 'node:fs';
import { inspectPortableExecutable } from './tools/packaging/windows-vc-runtime-closure.mts';
console.log(inspectPortableExecutable(readFileSync(process.argv[2]), process.argv[2]).imports.join('\n'));
TS
      ;;
  esac
}
for ((index=0; index<${#queue[@]}; index++)); do
  imports "${queue[index]}" > "$stage/imports"
  while IFS= read -r dependency; do
    name="${dependency##*/}"
    [ -n "$name" ] || continue
    directory=lib
    [ "$target" != windows-x64-msvc ] || directory=bin
    source="$runtime/$directory/$name"
    destination="$stage/runtime/$directory/$name"
    [ -f "$source" ] && [ ! -e "$destination" ] || continue
    cp -Lp "$source" "$destination"
    queue+=("$destination")
  done < "$stage/imports"
done
rm "$stage/imports"
if [ "$target" = windows-x64-msvc ]; then
  tools/dev/bun.sh tools/packaging/windows-vc-runtime-closure.mts stage \
    --root "$stage" --source-dir "$runtime/bin" --destination "$stage/runtime/bin"
fi
tools/dev/bun.sh runtimes/liboliphaunt-native/tools/native-runtime-payload.mts "$stage" --target "$target" --tool-set tools
bash tools/packaging/strip-native-binaries.sh --target "$target" "$stage"
tools/dev/bun.sh tools/packaging/platform-binary-contract.mts --target "$target" --root "$stage"
tools/dev/bun.sh tools/packaging/release-notices.mts stage "$stage" --profile native-tools
archive="$output/oliphaunt-tools-$version-$target.$archive_suffix"
tools/dev/bun.sh tools/packaging/archive-directory.mts "$stage" "$archive"
tools/dev/bun.sh tools/packaging/release-notices.mts check-archive "$archive" --profile native-tools
printf 'nativeToolsReleaseAsset=%s\n' "$archive"

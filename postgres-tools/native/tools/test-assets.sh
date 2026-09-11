#!/usr/bin/env bash
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"
. runtimes/liboliphaunt-native/tools/runtime-preflight.sh
target="${OLIPHAUNT_CI_TARGET:-$(oliphaunt_runtime_native_host_target_id)}"
version="$(tools/dev/bun.sh tools/release/product-version.mts version postgres-tools-native)"
case "$target" in
  linux-*|macos-*) extension=tar.gz; suffix="" ;;
  windows-x64-msvc) extension=zip; suffix=.exe ;;
  *) echo "unsupported native tools target: $target" >&2; exit 2 ;;
esac
archive="$root/target/postgres-tools/native/release-assets/oliphaunt-tools-$version-$target.$extension"
scratch="$(mktemp -d "$root/target/native-tools-consumer.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
tools/dev/bun.sh - "$archive" "$scratch" <<'TS'
import { extractPortableArchiveTree } from './tools/packaging/portable-archive.mts';
extractPortableArchiveTree(process.argv[2], process.argv[3]);
TS
case "$target" in
  linux-*)
    # No runtime package mount: missing libpq must fail in the consumer image.
    bash tools/packaging/check-linux-consumer-baseline.sh --target "$target" --root "$scratch"
    ;;
  *)
    for tool in pg_basebackup pg_dump psql; do
      DYLD_LIBRARY_PATH="$scratch/runtime/lib" "$scratch/runtime/bin/$tool$suffix" --version
    done
    ;;
esac

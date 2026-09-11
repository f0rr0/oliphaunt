#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
scratch="$(mktemp -d)"
scratch="$(cd "$scratch" && pwd -P)"
trap 'rm -rf "$scratch"' EXIT
source_dir="$scratch/source"
mkdir -p "$source_dir/icudt76l/coll" "$source_dir/76.1/config" "$scratch/empty"
printf 'root\n' > "$source_dir/icudt76l/root.res"
printf 'en\n' > "$source_dir/icudt76l/coll/en.res"
printf 'build-only\n' > "$source_dir/76.1/config/mh-darwin"
printf 'scaffolding\n' > "$source_dir/LICENSE"
script=database-resources/icu/tools/package-liboliphaunt-icu-data.sh
version="$(bun tools/release/product-version.mts version database-resources)"
archive="$scratch/output/database-resources-$version-icu-data.tar.gz"
bash "$script" "$source_dir" "$scratch/output"
cp "$archive" "$scratch/first.tar.gz"
bash "$script" "$source_dir" "$scratch/output"
cmp "$archive" "$scratch/first.tar.gz"
OLIPHAUNT_ICU_TEST_ARCHIVE="$archive" bun test ./database-resources/icu/tools/package-liboliphaunt-icu-data.test.mts
if bash "$script" "$scratch/empty" "$scratch/output" > "$scratch/empty.log" 2>&1; then
  echo 'Empty ICU input was accepted' >&2; exit 1
fi
mkdir -p "$scratch/linked/icudt76l"
ln -s "$source_dir/icudt76l/root.res" "$scratch/linked/icudt76l/root.res"
if bash "$script" "$scratch/linked" "$scratch/output" > "$scratch/linked.log" 2>&1; then
  echo 'Symlinked ICU input was accepted' >&2; exit 1
fi
grep -q 'must not contain symbolic links' "$scratch/linked.log"
cmp "$archive" "$scratch/first.tar.gz"
mkdir "$scratch/real-temp"
ln -s "$scratch/real-temp" "$scratch/temp-alias"
TMPDIR="$scratch/temp-alias" bash "$script" "$source_dir" "$scratch/output"
cmp "$archive" "$scratch/first.tar.gz"

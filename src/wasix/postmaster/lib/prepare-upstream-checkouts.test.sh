#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$project_root/../../.." && pwd)"
scratch="$(mktemp -d)"
mkdir -p "$repo_root/target/oliphaunt-wasix-postmaster"
work="$(mktemp -d "$repo_root/target/oliphaunt-wasix-postmaster/prepare-test.XXXXXX")"
trap 'rm -rf "$scratch" "$work"' EXIT

# Two real local repositories provide the runtime and all exact-pin gitlinks.
for name in leaf wasmer; do
  git init --quiet "$scratch/$name"
  git -C "$scratch/$name" config user.name 'Oliphaunt Test'
  git -C "$scratch/$name" config user.email test@example.invalid
  printf '/target/\n' > "$scratch/$name/.gitignore"
  printf '%s\n' "$name" > "$scratch/$name/source.txt"
  git -C "$scratch/$name" add .
done
git -C "$scratch/leaf" commit --quiet -m fixture
git -C "$scratch/leaf" commit --quiet --allow-empty -m history
leaf_ref="$(git -C "$scratch/leaf" rev-parse HEAD)"
for path in lib/napi wasmer-test-files tests/wast/spec; do
  mkdir -p "$scratch/wasmer/$path"
  git -C "$scratch/wasmer" update-index --add --cacheinfo "160000,$leaf_ref,$path"
done
git -C "$scratch/wasmer" commit --quiet -m fixture
git -C "$scratch/wasmer" commit --quiet --allow-empty -m history
wasmer_ref="$(git -C "$scratch/wasmer" rev-parse HEAD)"
for name in leaf wasmer; do
  git clone --quiet --depth 1 "file://$scratch/$name" "$scratch/$name-source"
done

prepare() {
  env UPSTREAM_WORK_ROOT="$work" \
    WASMER_SOURCE_ROOT="$scratch/wasmer-source" WASMER_REF="$wasmer_ref" \
    WASMER_NAPI_SOURCE_ROOT="$scratch/leaf-source" WASMER_NAPI_REF="$leaf_ref" \
    WASMER_TEST_FILES_SOURCE_ROOT="$scratch/leaf-source" WASMER_TEST_FILES_REF="$leaf_ref" \
    WASMER_SPEC_SOURCE_ROOT="$scratch/leaf-source" WASMER_SPEC_REF="$leaf_ref" \
    WASIX_LIBC_SOURCE_ROOT="$scratch/leaf-source" WASIX_LIBC_REF="$leaf_ref" \
    bash "$project_root/wasmer/bin/prepare-upstream-checkouts.sh" --skip-patches "$@"
}

# A restored Cargo cache contains outputs without any checkout or .git metadata.
for path in wasmer wasix-libc wasmer/lib/napi wasmer/wasmer-test-files wasmer/tests/wast/spec; do
  mkdir -p "$work/$path/target/release"
  printf 'cached output\n' > "$work/$path/target/release/cached.txt"
done
prepare
prepare
prepare --force

for path in wasmer wasix-libc wasmer/lib/napi wasmer/wasmer-test-files wasmer/tests/wast/spec; do
  expected_ref="$leaf_ref"
  [ "$path" != wasmer ] || expected_ref="$wasmer_ref"
  [ "$(git -C "$work/$path" rev-parse HEAD)" = "$expected_ref" ]
  git -C "$work/$path" fsck --no-dangling
  [ -z "$(git -C "$work/$path" status --porcelain)" ]
  [ "$(cat "$work/$path/target/release/cached.txt")" = 'cached output' ]
done
for name in leaf wasmer; do
  [ -z "$(git -C "$scratch/$name-source" status --porcelain)" ]
done
echo 'Runtime preparation preserves restored Cargo outputs and exact local source pins'

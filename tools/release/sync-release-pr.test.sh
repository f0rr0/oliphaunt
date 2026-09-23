#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
source_root="$PWD"
bun test ./tools/release/sync-release-pr.test.mts
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/repo"
repo="$scratch/repo"
cd "$repo"
git init -q
git config user.name Fixture
git config user.email fixture@example.invalid
printf 'ignored/\n' > .gitignore
cat > Cargo.toml <<'TOML'
[package]
name = "root"
version = "0.1.0"
[dependencies]
local = { path = "nested", version = "*" }
TOML
git add .
git commit -qm initial
mkdir nested ignored untracked
printf '[package]\nname="nested"\nversion="0.2.0"\n' > nested/Cargo.toml
cp nested/Cargo.toml ignored/Cargo.toml
git add nested
git commit -qm 'new package'
printf '[package]\nname="untracked"\nversion="0.1.0"\n' > untracked/Cargo.toml
observe() {
  bash "$source_root/tools/release/release-please-state.sh" "$repo" HEAD \
    bun "$source_root/tools/release/sync-release-pr.test.mts" inventory "$repo" "$1"
}
observe added
rm nested/Cargo.toml
observe deleted
cd "$source_root"
status=0
bun tools/release/sync-release-pr.mts --check --check-generated-release > "$scratch/result" 2>&1 || status=$?
[[ "$status" == 2 ]]
rg -q 'mutually exclusive' "$scratch/result"
echo 'Release sync: real tracked/untracked Cargo inventory and prior constraints passed'

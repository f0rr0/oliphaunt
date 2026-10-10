#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
source_root="$PWD"
bash tools/dev/bun.sh test ./tools/release/sync-release-pr.test.mts
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

git clone --quiet --shared "$source_root" "$scratch/release"
cp tools/release/sync-release-pr.sh "$scratch/release/tools/release/sync-release-pr.sh"
printf '/node_modules\n' >> "$scratch/release/.git/info/exclude"
ln -s "$source_root/node_modules" "$scratch/release/node_modules"
cd "$scratch/release"
git config user.name Fixture
git config user.email fixture@example.invalid
bun "$source_root/tools/release/sync-release-pr.test.mts" historical-consumer "$PWD" baseline
git add -A
git commit --allow-empty -qm baseline
git tag -f "oliphaunt-wasix-napi-v$(bun -p 'require("./src/wasix/node-addon/package.json").version')" >/dev/null
bun "$source_root/tools/release/sync-release-pr.test.mts" historical-consumer "$PWD" candidate
git add -A
git commit -qm 'chore(release): selected WASIX SDK'
bash tools/release/sync-release-pr.sh
bash tools/release/sync-release-pr.sh --check
bash tools/release/sync-release-pr.sh --check-generated-release
bun "$source_root/tools/release/sync-release-pr.test.mts" historical-consumer "$PWD" mismatch
status=0
bash tools/release/sync-release-pr.sh --check-generated-release > "$scratch/result" 2>&1 || status=$?
[[ "$status" != 0 ]]
rg -q 'differs from oliphaunt-wasix-napi .* runtime' "$scratch/result"
echo 'Release sync: published addon pin survives workspace drift; incompatible SDK pin rejected'

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

# The imported runner uses its own checkout's canonical catalog and real snapshots.
repo="$scratch/suppliers"
git clone --quiet --shared "$source_root" "$repo"
fixture_files=(
  build_defs/languages/cargo-metadata.mts
  tools/release/bazel-release-metadata.mts
  tools/release/bazel-shipping-inputs.mts
  tools/release/compatibility-version-parser.mts
  tools/release/example-cargo-versions.mts
  tools/release/native-supplier-artifacts.mts
  tools/release/release-artifact-targets.mts
  tools/release/release-dependency-plan.mts
  tools/release/sync-release-pr.mts
  tools/release/sync-release-pr.test.mts
)
for file in "${fixture_files[@]}"; do
  cp "$source_root/$file" "$repo/$file"
done
printf '/node_modules\n' >> "$repo/.git/info/exclude"
ln -s "$source_root/node_modules" "$repo/node_modules"
cd "$repo"
git config user.name Fixture
git config user.email fixture@example.invalid
git add -- "${fixture_files[@]}"
git commit --allow-empty -qm 'test: source controller baseline'
baseline="$(git rev-parse HEAD)"
bash tools/dev/bun.sh tools/release/sync-release-pr.test.mts supplier-map "$repo" prepare
git add .release-please-manifest.json src/native/sdks/rust/Cargo.toml src/native/broker/Cargo.toml
git commit -qm 'chore(release): select broker and source SDK independently'
OLIPHAUNT_EVIDENCE_COMMIT="$(git rev-parse 'HEAD^{commit}')"
OLIPHAUNT_EVIDENCE_TREE="$(git rev-parse 'HEAD^{tree}')"
export OLIPHAUNT_EVIDENCE_COMMIT OLIPHAUNT_EVIDENCE_TREE
for stage in held current; do
  bash tools/release/release-please-state.sh "$repo" HEAD \
    bash tools/release/with-product-history.sh "$repo" HEAD '' @workspace \
    bash tools/dev/bun.sh tools/release/sync-release-pr.test.mts supplier-map "$repo" "$stage"
done
echo 'Release sync: supplied held/current relationships and unknown-before-write admission passed'

# A root workspace binding has no product directory owner. Check the same
# public-inheritor decision used by release preparation without changing Files.
git reset --hard -q "$baseline"
bash tools/dev/bun.sh tools/release/sync-release-pr.test.mts workspace-floor "$repo" prepare
git add .release-please-manifest.json src/native/rust-bindings/Cargo.toml src/native/sdks/rust/Cargo.toml
git commit -qm 'chore(release): select Core and source SDK'
OLIPHAUNT_EVIDENCE_COMMIT="$(git rev-parse 'HEAD^{commit}')"
OLIPHAUNT_EVIDENCE_TREE="$(git rev-parse 'HEAD^{tree}')"
export OLIPHAUNT_EVIDENCE_COMMIT OLIPHAUNT_EVIDENCE_TREE
check_floor() {
  bash tools/release/release-please-state.sh "$repo" HEAD \
    bash tools/release/with-product-history.sh "$repo" HEAD '' @workspace \
    bash tools/dev/bun.sh tools/release/sync-release-pr.test.mts workspace-floor "$repo" check
}
workspace_before="$(git hash-object Cargo.toml)"
status=0
check_floor > "$scratch/floor-check" 2>&1 || status=$?
[[ "$status" == 1 ]]
rg -q '^Cargo.toml: liboliphaunt-native-bindings' "$scratch/floor-check"
[[ "$(git hash-object Cargo.toml)" == "$workspace_before" ]]
bash tools/dev/bun.sh tools/release/sync-release-pr.test.mts workspace-floor "$repo" hold
status=0
check_floor > "$scratch/held-check" 2>&1 || status=$?
[[ "$status" == 2 ]]
rg -q 'would change unselected public consumers: oliphaunt-query' "$scratch/held-check"
[[ "$(git hash-object Cargo.toml)" == "$workspace_before" ]]
echo 'Release sync: missing workspace floor and held public inheritor checks passed'

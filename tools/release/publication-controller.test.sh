#!/usr/bin/env bash
set -euo pipefail
owner="$(git rev-parse --show-toplevel)/tools/release"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/repo"
cd "$scratch/repo"
git init -q
git config user.name Fixture
git config user.email fixture@example.invalid
commit() { git add .; git commit -qm fixture; git rev-parse HEAD; }
reject() {
  local message="$1"; shift
  if bash "$owner/publication-controller.sh" "$@" > "$scratch/result" 2>&1; then echo 'Invalid controller accepted' >&2; exit 1; fi
  rg -q "$message" "$scratch/result"
}
printf original > product
source="$(commit)"
bash "$owner/publication-controller.sh" "$source" "$source"
mkdir -p tools/release
printf 'fixed publisher' > tools/release/crates-io-bootstrap-capacity.mts
controller="$(commit)"
bun "$owner/publication-controller.test.mts" proof "$source" "$controller"
bash "$owner/publication-controller.sh" "$source" "$controller" \
  bun "$owner/publication-controller.test.mts" inherited "$source" "$controller"
mkdir -p .github/scripts
printf 'newer publisher' > .github/scripts/download-completed-bootstrap.mts
newer="$(commit)"
bash "$owner/publication-controller.sh" "$source" "$newer"
bash "$owner/publication-controller.sh" --changes-only "$source" "$controller"
reject 'checkout|HEAD' "$source" "$controller"
for file in product extensions/artifacts/packages/tools/package-extension-release-carriers.mts Cargo.lock .github/workflows/ci.yml tools/release/moon.yml; do
  git checkout --quiet --detach "$controller"
  mkdir -p "$(dirname "$file")"
  printf changed > "$file"
  reject 'clean source checkout' "$source" "$controller"
  changed="$(commit)"
  reject 'non-publication changes' "$source" "$changed"
done
git checkout --quiet --detach "$source"
reject ancestor "$controller" "$source"
echo 'Publication controller: clean descendant, explicit proof and publication-only changes passed'

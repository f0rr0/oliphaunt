#!/usr/bin/env bash
set -euo pipefail
verifier="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify-product-tags.sh"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/repo"
cd "$scratch/repo"
git init --quiet
git init --quiet --bare "$scratch/remote"
git config user.name Fixture
git config user.email fixture@example.invalid
git remote add origin "$scratch/remote"
cat > release-please-config.json <<'JSON'
{"include-v-in-tag":true,"tag-separator":"-","packages":{".":{"component":"fixture","release-type":"simple","version-file":"VERSION"}}}
JSON
printf '1.2.3\n' > VERSION
git add .
git commit --quiet -m fixture
release="$(git rev-parse HEAD)"
check() { bash "$verifier" --target HEAD "$@" > "$scratch/result" 2>&1; }
reject() { if check "$@"; then echo "Unexpected tag acceptance: $*" >&2; exit 1; fi; }
accept() { if ! check "$@"; then cat "$scratch/result" >&2; exit 1; fi; }
reject fixture
accept --allow-missing fixture
tag=fixture-v1.2.3
git tag -a "$tag" -m release
reject fixture # A local tag cannot override remote absence.
git push --quiet origin "refs/tags/$tag"
accept --products-json '["fixture","fixture"]'
git commit --quiet --allow-empty -m next
reject --allow-missing fixture
git tag -f "$tag" >/dev/null
git push --quiet --force origin "refs/tags/$tag"
git tag -f "$tag" "$release" >/dev/null
accept fixture # Refresh a stale local tag from the remote.
[[ "$(git rev-parse "refs/tags/$tag")" == "$(git rev-parse HEAD)" ]]
git tag -f "$tag" "$(git rev-parse HEAD:VERSION)" >/dev/null
git push --quiet --force origin "refs/tags/$tag"
reject --allow-missing fixture # A blob tag is not an absent tag.
reject --products-json '[]'
reject --products-json '["$(touch injected)"]'
[[ ! -e injected ]]
git remote remove origin
git tag -f "$tag" >/dev/null
accept fixture
echo 'Product tags: remote authority, annotated tags, drift and invalid inputs passed'

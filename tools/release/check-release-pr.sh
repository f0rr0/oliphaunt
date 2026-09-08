#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(git rev-parse --show-toplevel)"
cd "$repo"
candidates=()
if [ -n "${GITHUB_BASE_REF:-}" ]; then candidates+=("origin/$GITHUB_BASE_REF" "$GITHUB_BASE_REF"); fi
candidates+=(origin/main main)
base=''
for ref in "${candidates[@]}"; do
  if base="$(git rev-parse --verify --quiet --end-of-options "$ref^{commit}")"; then break; fi
done
[ -n "$base" ] || { echo 'could not resolve release PR base' >&2; exit 1; }
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
if git cat-file -e "$base:.release-please-manifest.json" 2>/dev/null; then
  git show "$base:.release-please-manifest.json" > "$scratch/before.json"
else
  echo '{}' > "$scratch/before.json"
fi
products="$(bash "$script_dir/../dev/bun.sh" "$script_dir/check_release_pr_coverage.mts" "$scratch/before.json" "$repo")"
if [ "$products" = '[]' ]; then
  echo 'release PR verification skipped; product versions are unchanged'
  exit 0
fi
[ "$(git rev-parse HEAD^)" = "$base" ] || { echo 'release PR must have its current base as its parent' >&2; exit 1; }
git diff --quiet HEAD -- .release-please-manifest.json release-please-config.json || {
  echo 'commit release metadata before verifying the release PR' >&2; exit 1;
}
bash "$script_dir/release-please-state.sh" "$script_dir/../.." HEAD '' bash "$script_dir/with-release-history.sh" "$repo" HEAD bash "$script_dir/../dev/bun.sh" "$script_dir/verify-release-commit.mts" --repo "$repo" --products-json "$products"

#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-release-ci-scope.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
repo="$scratch/repo"
git init -q "$repo"
git -C "$repo" config user.name Fixture
git -C "$repo" config user.email fixture@example.invalid
cp "$root/release-please-config.json" "$root/.release-please-manifest.json" "$root/.prototools" "$repo/"
git -C "$repo" add .
git -C "$repo" commit -qm 'feat: initial products'
before="$(git -C "$repo" rev-parse HEAD)"
bash "$root/tools/dev/bun.sh" "$root/tools/ci/ci-release-scope.test.mts" bump "$repo"
git -C "$repo" add .
git -C "$repo" commit -qm 'chore(release): prepare products'
head="$(git -C "$repo" rev-parse HEAD)"
ln -s "$root/tools" "$repo/tools"
cat > "$repo/moon" <<'SH'
#!/usr/bin/env bash
set -eu
case "$1" in
  --version) echo "moon $FIXTURE_MOON_VERSION" ;;
  task-graph) cat "$FIXTURE_TASK_GRAPH" ;;
  *) echo 'unexpected affected query' >&2; exit 82 ;;
esac
SH
chmod +x "$repo/moon"
export MOON_BIN="$repo/moon"
FIXTURE_MOON_VERSION="$(sed -n 's/^moon *= *"\([^"]*\)".*/\1/p' "$root/.prototools")"
export FIXTURE_MOON_VERSION
export FIXTURE_TASK_GRAPH="${OLIPHAUNT_MOON_TASK_GRAPH_FILE:?expected captured Moon graph}"
export MOON_BASE="$before" MOON_HEAD="$head" GITHUB_REF=refs/heads/main
export CI_RELEASE_PRODUCTS_JSON='[]' GITHUB_OUTPUT='' WASM_TARGET=all NATIVE_TARGET=all MOBILE_TARGET=all
cd "$repo"
for event in pull_request push; do
  export GITHUB_EVENT_NAME="$event"
  if [[ "$event" == pull_request ]]; then export CI_GENERATED_RELEASE_PR=true;
  else export CI_GENERATED_RELEASE_PR=false; fi
  bash "$root/tools/ci/ci-plan.sh" > "$scratch/$event.out"
done
bash "$root/tools/dev/bun.sh" "$root/tools/ci/ci-release-scope.test.mts" invalid "$repo"
git add .release-please-manifest.json
git commit -qm 'chore(release): invalid product'
export MOON_BASE="$head"
MOON_HEAD="$(git rev-parse HEAD)"; export MOON_HEAD
if bash "$root/tools/ci/ci-plan.sh" > "$scratch/invalid.out" 2> "$scratch/invalid.err"; then
  echo 'unknown release owner was accepted' >&2; exit 1
fi
bash "$root/tools/dev/bun.sh" "$root/tools/ci/ci-release-scope.test.mts" assert "$scratch" "$head"

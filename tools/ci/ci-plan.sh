#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
while IFS= read -r name; do
  case "$name" in PROTO_*) unset "$name" ;; esac
done < <(compgen -e)
moon_bin="${MOON_BIN:-moon}"
expected=$(sed -n 's/^moon *= *"\([^"]*\)".*/\1/p' .prototools)
if [[ -z "$expected" || "$("$moon_bin" --version)" != "moon $expected" ]]; then
  echo "Moon $expected is required" >&2
  exit 1
fi
plan_dir=$(mktemp -d)
trap 'rm -rf "$plan_dir"' EXIT
export OLIPHAUNT_MOON_TASK_GRAPH_FILE="$plan_dir/graph.json"
export OLIPHAUNT_MOON_AFFECTED_FILE="$plan_dir/affected.json"
if [[ $# == 0 && (${CI_GENERATED_RELEASE_PR:-false} == true || (${GITHUB_EVENT_NAME:-} == push && ${GITHUB_REF:-} == refs/heads/main)) ]]; then
  : "${MOON_HEAD:?MOON_HEAD is required for automatic release qualification}"
  subject="$(git show -s --format=%s "$MOON_HEAD")"
  if [[ ${CI_GENERATED_RELEASE_PR:-false} == true || "$subject" == 'chore(release): '* ]]; then
    read -r _ parent extra <<<"$(git rev-list --parents -n 1 "$MOON_HEAD")"
    [[ -n "$parent" && -z "$extra" ]] || {
      echo 'release qualification requires a one-parent candidate' >&2
      exit 1
    }
    git show "$MOON_HEAD:release-please-config.json" >"$plan_dir/config.json"
    git show "$parent:.release-please-manifest.json" >"$plan_dir/before.json"
    git show "$MOON_HEAD:.release-please-manifest.json" >"$plan_dir/after.json"
    CI_RELEASE_PRODUCTS_JSON="$(bash tools/dev/bun.sh tools/release/verify-release-commit.mts --manifest-transition "$plan_dir/config.json" "$plan_dir/before.json" "$plan_dir/after.json")"
    export CI_RELEASE_PRODUCTS_JSON
  fi
fi
# A frozen carrier replaces only the React Native package's unchanged Apple
# metadata input. Missing/stale state falls back to the normal producers.
unset OLIPHAUNT_REUSE_IOS_CARRIER
carrier_cache=target/ci/ios-carrier
if [[ $# == 0 && ${GITHUB_EVENT_NAME:-} != workflow_dispatch && ${CI_RELEASE_PRODUCTS_JSON:-[]} == '[]' && -s "$carrier_cache/source-sha" && -s "$carrier_cache/manifest.json" ]]; then
  producer_sha="$(cat "$carrier_cache/source-sha")"
  if [[ "$producer_sha" =~ ^[0-9a-f]{40}$ ]] && git cat-file -e "$producer_sha^{commit}" 2>/dev/null; then
    git diff --name-only "$producer_sha" HEAD > "$plan_dir/carrier-changes"
    if [[ -s "$plan_dir/carrier-changes" ]]; then
      (unset MOON_BASE MOON_HEAD; "$moon_bin" query affected stdin --upstream none --downstream deep < "$plan_dir/carrier-changes") > "$plan_dir/carrier-affected.json"
    else
      printf '{"tasks":{}}\n' > "$plan_dir/carrier-affected.json"
    fi
    if bun -e 'const data=await Bun.file(process.argv[1]).json(); process.exit(Object.hasOwn(data.tasks ?? {}, "liboliphaunt-native:finalize-runtime-ios-abi") ? 1 : 0)' "$plan_dir/carrier-affected.json" &&
      bun src/native/sdks/swift/tools/ios-carrier-manifest.mts --base-carrier "$carrier_cache/manifest.json" --output "$plan_dir/carrier.json"; then
      export OLIPHAUNT_REUSE_IOS_CARRIER=true
    fi
  fi
fi
"$moon_bin" task-graph --json >"$OLIPHAUNT_MOON_TASK_GRAPH_FILE"
if [[ $# == 0 && ${GITHUB_EVENT_NAME:-} != workflow_dispatch && (-z ${CI_RELEASE_PRODUCTS_JSON:-} || ${CI_RELEASE_PRODUCTS_JSON:-} == '[]') ]]; then
  : "${MOON_BASE:?MOON_BASE is required for affected CI planning}"
  : "${MOON_HEAD:?MOON_HEAD is required for affected CI planning}"
  "$moon_bin" query affected --upstream none --downstream deep </dev/null >"$OLIPHAUNT_MOON_AFFECTED_FILE"
fi
bash tools/ci/with-projects.sh tools/ci/ci_plan.mts "$@"

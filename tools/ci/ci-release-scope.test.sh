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
"${MOON_BIN:-moon}" query projects > "$scratch/projects.json"
export FIXTURE_PROJECTS="$scratch/projects.json"
unset OLIPHAUNT_MOON_PROJECTS_FILE
cat > "$repo/moon" <<'SH'
#!/usr/bin/env bash
set -eu
case "$1" in
  --version) echo "moon $FIXTURE_MOON_VERSION" ;;
  task-graph) cat "$FIXTURE_TASK_GRAPH" ;;
  query)
    if [[ "$2" == projects ]]; then cat "$FIXTURE_PROJECTS";
    elif [[ ${FIXTURE_AFFECTED:-false} == true && "$2" == affected ]]; then
      if [[ ${3:-} == stdin ]]; then
        [[ -n "$(cat)" ]] || { echo 'empty stdin must not be queried as a Git ref' >&2; exit 82; }
        if [[ ${FIXTURE_IOS_CHANGED:-false} == true ]]; then
          printf '{"tasks":{"liboliphaunt-native:finalize-runtime-ios-abi":{}}}\n'
        else printf '{"tasks":{}}\n'; fi
      else
        printf '{"projects":{"integration-examples":{"other":true}},"tasks":{"integration-examples:react-native-android-build":{"other":true}}}\n'
      fi
    else echo 'unexpected affected query' >&2; exit 82; fi ;;
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
export GITHUB_EVENT_NAME=workflow_dispatch CI_GENERATED_RELEASE_PR=false
export CI_RELEASE_PRODUCTS_JSON='["oliphaunt-extension-vector","oliphaunt-js"]'
bash "$root/tools/ci/ci-plan.sh" > "$scratch/workflow_dispatch.out"
export GITHUB_EVENT_NAME=push CI_RELEASE_PRODUCTS_JSON='[]'
bash "$root/tools/dev/bun.sh" "$root/tools/ci/ci-release-scope.test.mts" invalid "$repo"
git add .release-please-manifest.json
git commit -qm 'chore(release): invalid product'
export MOON_BASE="$head"
MOON_HEAD="$(git rev-parse HEAD)"; export MOON_HEAD
if bash "$root/tools/ci/ci-plan.sh" > "$scratch/invalid.out" 2> "$scratch/invalid.err"; then
  echo 'unknown release owner was accepted' >&2; exit 1
fi
bash "$root/tools/dev/bun.sh" "$root/tools/ci/ci-release-scope.test.mts" assert "$scratch" "$head"

# A missing or unusable optimization cache must keep the normal producer path.
# Same-SHA reuse has an empty diff, which Moon otherwise interprets as a ref.
git commit --allow-empty -qm 'fix: Android app'
export MOON_BASE="$head" GITHUB_REF=refs/heads/fixture GITHUB_EVENT_NAME=pull_request
MOON_HEAD="$(git rev-parse HEAD)"; export MOON_HEAD
export FIXTURE_AFFECTED=true
ln -s "$root/src" "$repo/src"
mkdir -p target/ci/ios-carrier
bun - "$root" "$scratch/carrier.json" <<'JS'
import {writeFileSync, readFileSync} from 'node:fs';
const root = process.argv[2];
const {iosBaseLegalMetadata} = await import(`${root}/src/native/sdks/swift/tools/ios-carrier-manifest.mts`);
const version = readFileSync(`${root}/src/native/runtime/VERSION`, 'utf8').trim();
const tag = `liboliphaunt-native-v${version}`;
const assets = [
  ['base-xcframework', `liboliphaunt-${version}-apple-spm-xcframework.zip`, 'zip', 'liboliphaunt.xcframework'],
  ['runtime-resources', `liboliphaunt-${version}-runtime-resources-ios-datum64.tar.gz`, 'tar.gz', 'oliphaunt'],
].map(([role, name, format, member]) => ({role, name, format, member, bytes:1, sha256:'a'.repeat(64),
  url:`https://github.com/f0rr0/oliphaunt/releases/download/${tag}/${name}`}));
writeFileSync(process.argv[3], JSON.stringify({schema:'oliphaunt-react-native-ios-carrier-v1',
  base:{product:'liboliphaunt-native', version, tag, assets}, carriers:[], extensions:[],
  legal:{base:iosBaseLegalMetadata(), extensions:[]}}));
JS
for scenario in missing same-sha invalid-sha corrupt unchanged-ios changed-ios; do
  expected=false
  cp "$scratch/carrier.json" target/ci/ios-carrier/manifest.json
  printf '%s\n' "$MOON_HEAD" > target/ci/ios-carrier/source-sha
  export FIXTURE_IOS_CHANGED=false
  case "$scenario" in
    missing) rm target/ci/ios-carrier/manifest.json ;;
    same-sha) expected=true ;;
    invalid-sha) printf 'invalid\n' > target/ci/ios-carrier/source-sha ;;
    corrupt) printf '{invalid\n' > target/ci/ios-carrier/manifest.json ;;
    unchanged-ios) printf '%s\n' "$before" > target/ci/ios-carrier/source-sha; expected=true ;;
    changed-ios) printf '%s\n' "$before" > target/ci/ios-carrier/source-sha; export FIXTURE_IOS_CHANGED=true ;;
  esac
  bash "$root/tools/ci/ci-plan.sh" > "$scratch/$scenario.out" 2> "$scratch/$scenario.err"
  bun -e 'import assert from "node:assert/strict"; const output=await Bun.file(process.argv[2]).text(); assert(output.includes(`reuse_ios_carrier=${process.argv[1]}`)); const jobs=JSON.parse(output.match(/^jobs=(.+)$/m)[1]); assert.equal(jobs.includes("liboliphaunt-native-ios-abi"), process.argv[1] !== "true")' "$expected" "$scratch/$scenario.out"
done
echo 'Frozen iOS metadata: same-SHA reuse and cold, corrupt, changed-input fallbacks passed'

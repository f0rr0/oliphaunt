#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if [[ "${1:-}" != --with-projects ]]; then
  exec bash tools/ci/with-projects.sh --exec bash "$0" --with-projects
fi
source_root="$PWD"
bun test ./tools/release/publish_swiftpm_source_tag.test.mts
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
bun tools/release/publish_swiftpm_source_tag.test.mts prepare "$scratch"
publisher="$source_root/tools/release/publish-swiftpm-source-tag.sh"
export GITHUB_ACTIONS=false GITHUB_SHA='' OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH='' REGISTRY_JOB_HARD_DEADLINE_EPOCH=''
mkdir "$scratch/resource-repo"
cd "$scratch/resource-repo"
git init -q
git init -q --bare "$scratch/resource-remote"
git config user.name fixture
git config user.email fixture@example.invalid
git config "url.$scratch/resource-remote.insteadOf" https://github.com/fixture/resources.git
printf 'must not be distributed' > unrelated-monorepo-file
git add .
git commit -qm source
commit="$(git rev-parse HEAD)"
resource_version="$(jq -r .resources "$scratch/versions.json")"
local_ref="refs/oliphaunt-swiftpm/database-resources/$resource_version"
resource() { bash "$publisher" --target HEAD --product database-resources --repository fixture/resources --source-archive "$scratch/source.zip" "$@" > "$scratch/result" 2>&1; }
resource
projected="$(git rev-parse "$local_ref")"
[[ -z "$(git show -s --format=%P "$projected")" ]]
if git ls-tree --name-only "$projected" | rg -q unrelated-monorepo-file; then exit 1; fi
[[ "$(git show "$projected:oliphaunt-source.json" | jq -r .source.commit)" == "$commit" ]]
[[ "$(git show "$projected:LICENSE")" == 'fixture license' ]]
resource --push
[[ "$(git ls-remote --refs --tags https://github.com/fixture/resources.git "refs/tags/$resource_version")" == "$projected"$'\t'"refs/tags/$resource_version" ]]
resource
[[ "$(git rev-parse "$local_ref")" == "$projected" ]]
mkdir "$scratch/repo"
cd "$scratch/repo"
git init -q
git init -q --bare "$scratch/remote"
git remote add origin "$scratch/remote"
git config user.name fixture
git config user.email fixture@example.invalid
mkdir Sources
printf '// development manifest\n' > Package.swift
printf 'public let base = true\n' > Sources/Base.swift
git add .
GIT_AUTHOR_DATE='1700000000 +0000' GIT_COMMITTER_DATE='1700000000 +0000' git commit -qm 'release source'
source="$(git rev-parse HEAD)"
cat > Package.swift.release <<'SWIFT'
// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "Oliphaunt", targets: [
  .binaryTarget(name: "COliphaunt", url: "https://example.invalid/liboliphaunt-native-v0.1.0/apple-spm-xcframework.zip", checksum: "abc")
])
SWIFT
mkdir -p frozen-tree/generated/swiftpm
frozen=frozen-tree/generated/swiftpm/Frozen.swift
printf 'public let frozen = true\n' > "$frozen"
cp .git/index "$scratch/index"
version="$(jq -r .swift "$scratch/versions.json")"
ref="refs/tags/$version"
invoke() { bash "$publisher" --target HEAD --manifest Package.swift.release --include-tree frozen-tree "$@" > "$scratch/result" 2>&1; }
invoke --preflight
[[ -z "$(git tag --list "$version")" && -z "$(git ls-remote --refs --tags origin "$ref")" ]]
GIT_AUTHOR_DATE='946684800 +0000' GIT_COMMITTER_DATE='946684800 +0000' GIT_AUTHOR_NAME=ambient invoke
first="$(git rev-parse "$ref")"
[[ "$(git show -s --format=%P "$first")" == "$source" ]]
git show "$first:Package.swift" > "$scratch/manifest"
cmp Package.swift.release "$scratch/manifest"
[[ "$(git show "$first:Sources/Base.swift")" == 'public let base = true' ]]
[[ "$(git show "$first:generated/swiftpm/Frozen.swift")" == 'public let frozen = true' ]]
[[ "$(git show -s '--format=%an <%ae>' "$first")" == 'oliphaunt-release-bot <oliphaunt-release-bot@users.noreply.github.com>' ]]
cmp .git/index "$scratch/index"
git tag -d "$version" > /dev/null
GIT_AUTHOR_DATE='1893456000 +0000' GIT_COMMITTER_DATE='1893456000 +0000' invoke
[[ "$(git rev-parse "$ref")" == "$first" ]]
invoke
mkdir "$scratch/bin"
export SWIFT_REAL_GIT="$(command -v git)" SWIFT_PUSH_LOG="$scratch/pushes"
cat > "$scratch/bin/git" <<'SH'
#!/usr/bin/env bash
if [[ "$1" == push ]]; then
  echo push >> "$SWIFT_PUSH_LOG"
  "$SWIFT_REAL_GIT" "$@"
  exit 7
fi
exec "$SWIFT_REAL_GIT" "$@"
SH
chmod +x "$scratch/bin/git"
if PATH="$scratch/bin:$PATH" REGISTRY_JOB_HARD_DEADLINE_EPOCH="$(( $(date +%s)+90 ))" invoke --push; then exit 1; fi
rg -q 'requires two complete' "$scratch/result"
[[ -z "$(git ls-remote --refs --tags origin "$ref")" ]]
PATH="$scratch/bin:$PATH" invoke --push
rg -q 'failure reconciled' "$scratch/result"
[[ "$(cat "$scratch/pushes")" == push ]]
[[ "$(git ls-remote --refs --tags origin "$ref")" == "$first"$'\t'"$ref" ]]
git tag -d "$version" > /dev/null
invoke --preflight
[[ -z "$(git tag --list "$version")" ]]
invoke
printf 'public let frozen = false\n' > "$frozen"
if invoke; then exit 1; fi
if invoke --preflight; then exit 1; fi
[[ "$(git rev-parse "$ref")" == "$first" ]]
printf 'public let frozen = true\n' > "$frozen"
mkdir -p tools/release
cp "$scratch/release-bot.json" tools/release/release-bot.json
git add tools/release/release-bot.json
git commit -qm 'configure App identity'
git tag -d "$version" > /dev/null
printf 'invalid ambient identity' > tools/release/release-bot.json
invoke
[[ "$(git show -s '--format=%an <%ae>' "$ref")" == "$(jq -r '.name+" <"+.email+">"' "$scratch/release-bot.json")" ]]
if invoke --preflight --push; then exit 1; fi
echo 'SwiftPM: isolated resources, deterministic projection, exact tags and lost-response reconciliation passed'

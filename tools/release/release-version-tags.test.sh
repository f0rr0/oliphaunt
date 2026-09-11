#!/usr/bin/env bash
set -euo pipefail
source_root="$(git rev-parse --show-toplevel)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
cd "$scratch"
git init -q
git config user.name Fixture
git config user.email fixture@example.invalid
git commit --allow-empty -qm first
git rev-parse HEAD > first
git tag product-v0.1.0
git tag liboliphaunt-native-v0.1.0
git commit --allow-empty -qm release
git rev-parse HEAD > expected-head
git tag -a inner -m release
git -c advice.nestedTag=false tag -a product-v0.2.0 -m nested inner
git tag oliphaunt-swift-v0.7.0
git commit --allow-empty -qm 'SwiftPM projection'
git tag -a 0.7.0 -m SwiftPM
printf payload > blob
git tag product-v0.3.0 "$(git hash-object -w blob)"
mkdir -p extensions/contrib tools/release tools/dev
printf fixture > extensions/contrib/carriers.toml
git add extensions/contrib/carriers.toml
git commit -qm 'add contrib carrier'
git tag -a liboliphaunt-native-v0.2.0 -m 'with contrib'
cp "$source_root/tools/release/with-release-tags.sh" tools/release/
cp "$source_root/tools/release/check-release-versions.sh" check.sh
cat > tools/dev/bun.sh <<'SH'
#!/usr/bin/env bash
set -eu
printf '%s' "$RELEASE_HEAD_COMMIT" > head
cp "$RELEASE_TAG_REFS" refs
cp "$RELEASE_TAG_COMMITS" commits
cp "$RELEASE_TAG_CONTRIB" contrib
SH
RELEASE_HEAD_COMMIT="$(cat first)" bash check.sh --head-ref "$(cat expected-head)"
cd "$source_root"
TEST_TAG_ROOT="$scratch" bun test ./tools/release/release-version-tags.test.mts

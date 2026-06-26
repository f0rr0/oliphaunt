#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

fail() {
  echo "$1" >&2
  exit 1
}

require_file() {
  [[ -f "$1" ]] || fail "missing required tooling file: $1"
}

require_file package.json
require_file .prototools
require_file .gitignore
require_file pnpm-workspace.yaml
require_file pnpm-lock.yaml
require_file biome.json
require_file renovate.json
require_file .markdownlint-cli2.jsonc
require_file .typos.toml
require_file .lychee.toml
require_file .config/nextest.toml
require_file src/sdks/swift/.swift-format
require_file src/sdks/swift/.swiftlint.yml
require_file src/runtimes/liboliphaunt/native/bin/common.sh
require_file .github/moon.yml
require_file .github/workflows/ci.yml
require_file .github/scripts/setup-native-build-tools.sh
require_file .moon/workspace.yml
require_file docs/maintainers/tooling.md
require_file tools/test/moon.yml
require_file tools/test/run-js-tests.mjs
require_file tools/graph/cache-witness.mjs
require_file tools/policy/check-python-entrypoints.mjs
require_file tools/policy/check-native-boundaries.mjs
require_file tools/policy/python-entrypoints.allowlist
require_file tools/runtime/preflight.sh
require_file tools/dev/bun.sh
require_file tools/dev/deno.sh
require_file tools/dev/install-actionlint.sh
require_file tools/dev/setup-android-sdk.sh
require_file .github/actions/setup-wasmer-llvm/action.yml

while IFS= read -r tracked_patch_input; do
  eol_attr="$(git check-attr eol -- "$tracked_patch_input" | awk -F': ' '{print $3}')"
  [[ "$eol_attr" == "lf" ]] ||
    fail "$tracked_patch_input must be covered by .gitattributes with eol=lf; Windows checkouts corrupt PostgreSQL patch application without it"
done < <(git ls-files -- '*.patch' '*.diff' ':(glob)src/**/patches/series')

proto_version() {
  local tool="$1"
  awk -F '=' -v tool="$tool" '
    $1 ~ "^[[:space:]]*" tool "[[:space:]]*$" {
      value=$2
      gsub(/^[[:space:]"]+|[[:space:]"]+$/, "", value)
      print value
      found=1
    }
    END { if (!found) exit 1 }
  ' .prototools
}

MOON_VERSION="$(proto_version moon)"
NODE_VERSION="$(proto_version node)"
PNPM_VERSION="$(proto_version pnpm)"
BUN_VERSION="$(proto_version bun)"
DENO_VERSION="$(proto_version deno)"
DENO_VERSION_WITH_PREFIX="v$DENO_VERSION"

grep -Fq "\"packageManager\": \"pnpm@$PNPM_VERSION\"" package.json ||
  fail "root package.json must pin pnpm through packageManager"
grep -Fq '"node": ">=22.13 <25"' package.json ||
  fail "root package.json must declare the supported Node runtime band"
grep -Fq "\"pnpm\": \"$PNPM_VERSION\"" package.json ||
  fail "root package.json must declare the exact supported pnpm version"
grep -Fq "default: \"$NODE_VERSION\"" .github/actions/setup-node-pnpm/action.yml ||
  fail "setup-node-pnpm must default to the pinned Node version from .prototools"
if grep -Fq 'cache: pnpm' .github/actions/setup-node-pnpm/action.yml; then
  fail "setup-node-pnpm must not use actions/setup-node pnpm cache before pnpm is installed"
fi
grep -Fq 'Resolve pnpm store' .github/actions/setup-node-pnpm/action.yml ||
  fail "setup-node-pnpm must resolve the pnpm store after enabling pinned pnpm"
grep -Fq 'key: pnpm-store-${{ runner.os }}-${{ runner.arch }}-node-${{ inputs.node-version }}-pnpm-${{ inputs.pnpm-version }}-${{ hashFiles('\''pnpm-lock.yaml'\'') }}' .github/actions/setup-node-pnpm/action.yml ||
  fail "setup-node-pnpm pnpm store cache key must include runner, Node, pnpm, and lockfile"
grep -Fq 'moonrepo/setup-toolchain' .github/actions/setup-moon/action.yml ||
  fail "setup-moon must install the pinned proto/Moon toolchain through moonrepo/setup-toolchain"
grep -Fq 'auto-install: true' .github/actions/setup-moon/action.yml ||
  fail "setup-moon must allow proto to auto-install pinned tools from .prototools"
if grep -Fq 'continue-on-error: true' .github/actions/setup-moon/action.yml; then
  fail "setup-moon must fail closed when pinned proto/Moon setup fails"
fi
if grep -Fq 'steps.setup-toolchain.outcome' .github/actions/setup-moon/action.yml; then
  fail "setup-moon must not implement fallback branches around pinned proto/Moon setup"
fi
grep -Fq 'path: ~/.moon/plugins' .github/actions/setup-moon/action.yml ||
  fail "setup-moon must cache Moon toolchain plugins to avoid live plugin downloads in every CI job"
grep -Fq "key: moon-plugins-\${{ runner.os }}-\${{ runner.arch }}-\${{ hashFiles('.moon/toolchains.yml', '.moon/workspace.yml', '.prototools') }}" .github/actions/setup-moon/action.yml ||
  fail "setup-moon Moon plugin cache key must include Moon/proto toolchain pins"
grep -Fq 'Hydrate Moon plugins' .github/actions/setup-moon/action.yml ||
  fail "setup-moon must hydrate Moon plugins before product jobs run"
if grep -Fq 'Moon plugin hydration failed on attempt' .github/actions/setup-moon/action.yml; then
  fail "setup-moon must not hide Moon plugin hydration failures behind retry loops"
fi
grep -Fq -- '--retry-all-errors' .github/actions/setup-wasmer-llvm/action.yml ||
  fail "setup-wasmer-llvm must retry transient LLVM archive download failures"
grep -Fq -- '--connect-timeout 20' .github/actions/setup-wasmer-llvm/action.yml ||
  fail "setup-wasmer-llvm must bound LLVM archive download connection stalls"
if grep -Eq 'node-version:|pnpm-version:|pnpm moon' .github/actions/setup-moon/action.yml; then
  fail "setup-moon must not expose stale Node/pnpm inputs or launch Moon through pnpm"
fi
grep -Fq "NODE_VERSION: $NODE_VERSION" .github/workflows/ci.yml ||
  fail "CI must expose the pinned Node version explicitly"
grep -Fq 'ACTIONLINT_VERSION: 1.7.12' .github/workflows/ci.yml ||
  fail "CI must expose the pinned actionlint version explicitly"
grep -Fq "NODE_VERSION: $NODE_VERSION" .github/workflows/release.yml ||
  fail "release workflow must expose the pinned Node version explicitly"
grep -Fq 'NPM_VERSION: 11.5.1' .github/workflows/release.yml ||
  fail "release workflow must pin npm for trusted publishing"
grep -Fq 'npm install --global "npm@${{ env.NPM_VERSION }}"' .github/workflows/release.yml ||
  fail "release workflow must install the pinned npm CLI before trusted publishing checks"
if grep -Fq 'node-version: 24' .github/workflows/release.yml; then
  fail "release workflow must not drift to a separate Node 24 publishing runtime"
fi
for tool_name in moon node pnpm bun deno; do
  proto_version "$tool_name" >/dev/null ||
    fail ".prototools must pin $tool_name"
done
for moon_experiment in \
  'asyncAffectedTracking: true' \
  'asyncGraphBuilding: true' \
  'casOutputsCache: true' \
  'nativeFileHashing: true'
do
  grep -Fq "$moon_experiment" .moon/workspace.yml ||
    fail ".moon/workspace.yml must enable Moon v2.3 graph/cache experiment: $moon_experiment"
done
if grep -Fq 'MOON_CONCURRENCY=1' package.json; then
  fail "root command-card scripts must not force single-threaded Moon execution; use MOON_CONCURRENCY=1 only as an ad-hoc debug override"
fi
root_fallback_hits="$(
  grep -R --exclude=check-tooling-stack.sh --exclude-dir=target --exclude-dir=node_modules \
    -F 'git rev-parse --show-toplevel 2>/dev/null || pwd' tools src examples .github || true
)"
if [[ -n "$root_fallback_hits" ]]; then
  echo "$root_fallback_hits" >&2
  fail "repo scripts must fail closed when not run inside the Oliphaunt git checkout; do not fall back to pwd"
fi
node -e '
const fs = require("node:fs");
const scripts = Object.keys(JSON.parse(fs.readFileSync("package.json", "utf8")).scripts ?? {});
if (scripts.length !== 0) {
  console.error(`root package.json scripts must be empty; use moon directly, got ${scripts.join(", ")}`);
  process.exit(1);
}
'
for retired_moon_helper in tools/graph/moon.mjs tools/graph/tool-versions.mjs tools/graph/tool_versions.py tools/graph/run-affected-task.py; do
  if [ -e "$retired_moon_helper" ]; then
    fail "retired Moon helper must not exist: $retired_moon_helper"
  fi
done
for catalog_dep in '@vitest/coverage-v8' 'tsx' 'typedoc' 'typescript' 'vitest'; do
  grep -Eq "^[[:space:]]+\"?$catalog_dep\"?:" pnpm-workspace.yaml ||
    fail "pnpm-workspace.yaml must catalog shared JS test/build tool $catalog_dep"
done
for package_file in src/sdks/js/package.json src/sdks/react-native/package.json; do
  for catalog_dep in '@vitest/coverage-v8' 'tsx' 'typedoc' 'typescript' 'vitest'; do
    grep -Fq "\"$catalog_dep\": \"catalog:\"" "$package_file" ||
      fail "$package_file must consume shared JS test/build tool $catalog_dep through pnpm catalog:"
  done
done
grep -Fq "bun tools/policy/assertions/assert-source-inputs.mjs postgres18" src/postgres/versions/18/moon.yml ||
  fail "source input checks must use the Bun source-input assertion task"
grep -Fq "bun tools/policy/fetch-sources.mjs" src/sources/moon.yml ||
  fail "source fetch task must use cross-platform Bun"
grep -Fq "bun tools/policy/assertions/assert-source-inputs.mjs toolchains" src/sources/toolchains/moon.yml ||
  fail "toolchain source checks must use the Bun source-input assertion task"
grep -Fq 'language: "javascript"' src/shared/extension-runtime-contract/moon.yml ||
  fail "extension runtime contract checks must be modeled as JavaScript/Bun tooling"
grep -Fq 'bun src/shared/extension-runtime-contract/tools/check-contract.mjs' src/shared/extension-runtime-contract/moon.yml ||
  fail "extension runtime contract check must use the Bun checker"
if [ -e src/shared/extension-runtime-contract/tools/check-contract.py ]; then
  fail "extension runtime contract checker must not use the retired Python implementation"
fi
if [ -e src/extensions/tools/check-extension-tree.py ]; then
  fail "extension tree checker must not use the retired Python implementation"
fi
if git grep -n 'check-extension-tree\.py' -- src/extensions >/tmp/oliphaunt-extension-tree-python-grep.$$ 2>/dev/null; then
  cat /tmp/oliphaunt-extension-tree-python-grep.$$ >&2
  rm -f /tmp/oliphaunt-extension-tree-python-grep.$$
  fail "extension Moon tasks must use the Bun extension tree checker"
fi
rm -f /tmp/oliphaunt-extension-tree-python-grep.$$
grep -Fq 'bun src/extensions/tools/check-extension-tree.mjs' src/extensions/contrib/moon.yml ||
  fail "contrib extension aggregate check must use the Bun extension tree checker"
for retired_source_input_checker in tools/policy/check-source-inputs.sh tools/policy/check-source-inputs.mjs; do
  if git ls-files --error-unmatch "$retired_source_input_checker" >/dev/null 2>&1; then
    fail "source-input policy parsers must live under tools/policy/assertions/assert-*.mjs"
  fi
done
grep -Fq 'bun --version' .github/actions/setup-moon/action.yml ||
  fail "shared Moon setup must verify the pinned Bun runtime for Bun-backed Moon tasks"
if grep -Fq -- '--affected --downstream deep' package.json; then
  fail "root package scripts must not carry affected Moon aliases"
fi
grep -Fq 'moon(["query", "affected", "--upstream", "none", "--downstream", "none"])' tools/graph/affected.py ||
  fail "affected runner must get direct affected projects from Moon"
grep -Fq 'moon(["query", "affected", "--upstream", "none", "--downstream", "deep"])' tools/graph/affected.py ||
  fail "affected runner must get downstream affected projects from Moon"
grep -Fq 'moon(["query", "tasks"])' tools/graph/affected.py ||
  fail "affected runner must discover task availability from Moon"
grep -Fq 'tools/dev/bun.sh' tools/dev/doctor.sh ||
  fail "pnpm doctor must report the pinned Bun launcher used by TypeScript SDK checks"
grep -Fq 'https://github.com/oven-sh/bun/releases/download/bun-v$version/$asset' tools/dev/bun.sh ||
  fail "repo Bun launcher must use official pinned Bun release binaries"
if grep -Fq 'python3' tools/dev/bun.sh; then
  fail "repo Bun launcher must not use Python for archive extraction"
fi
grep -Fq 'unzip -q "$archive" -d "$tmp_dir"' tools/dev/bun.sh ||
  fail "repo Bun launcher must extract pinned release archives with unzip"
grep -Fq 'tools/dev/bun.sh" "$package_dir/.oliphaunt-bun-smoke.ts"' src/sdks/js/tools/check-sdk.sh ||
  fail "TypeScript SDK package checks must run Bun smoke through the pinned repo Bun launcher"
grep -Fq 'missing optional deno' tools/dev/doctor.sh ||
  fail "pnpm doctor must report the pinned Deno runtime needed by strict JSR consumer gates"
grep -Fq 'https://github.com/denoland/deno/releases/download/v$version/deno-$target.zip' tools/dev/deno.sh ||
  fail "repo Deno launcher must use official pinned Deno release binaries"
if grep -Fq 'python3' tools/dev/deno.sh; then
  fail "repo Deno launcher must not use Python for archive extraction"
fi
grep -Fq 'unzip -q "$archive" -d "$tmp_dir"' tools/dev/deno.sh ||
  fail "repo Deno launcher must extract pinned release archives with unzip"
grep -Fq 'tools/dev/deno.sh" run --allow-read --allow-env' src/sdks/js/tools/check-sdk.sh ||
  fail "TypeScript SDK package checks must run Deno smoke through the pinned repo Deno launcher"
grep -Fq 'RIPGREP_VERSION="${RIPGREP_VERSION:-15.1.0}"' tools/dev/bootstrap-tools.sh ||
  fail "local tool bootstrap must pin ripgrep"
grep -Fq 'install_cargo_tool ripgrep rg "$RIPGREP_VERSION"' tools/dev/bootstrap-tools.sh ||
  fail "local tool bootstrap must install the pinned ripgrep binary"

bun tools/policy/check-python-entrypoints.mjs
if grep -Fq "python3 <<'PY'" tools/policy/check-native-boundaries.sh; then
  fail "native boundary policy must use the Bun checker instead of inline Python"
fi
if grep -Fq 'python3' tools/dev/bootstrap-tools.sh; then
  fail "local tool bootstrap must not use Python for archive extraction"
fi
grep -Fq 'unzip -q "$archive" -d "$tmp"' tools/dev/bootstrap-tools.sh ||
  fail "local tool bootstrap must extract cargo-binstall zip archives with unzip"
grep -Fq 'cargo install ripgrep --version 15.1.0 --locked' .github/actions/setup-rust-tools/action.yml ||
  fail "shared CI Rust setup must install pinned ripgrep for repo policy and native probes"
grep -Fq '"$script_dir/install-actionlint.sh"' tools/dev/bootstrap-tools.sh ||
  fail "local tool bootstrap must install actionlint through the shared actionlint installer"
grep -Fq 'ACTIONLINT_VERSION="${ACTIONLINT_VERSION:-1.7.12}"' tools/dev/install-actionlint.sh ||
  fail "shared actionlint installer must pin actionlint 1.7.12"
grep -Fq 'require_brew_tool autoconf autoconf' .github/scripts/setup-native-build-tools.sh ||
  fail "native CI setup must install autoconf for PostGIS autogen builds"
grep -Fq 'require_brew_tool aclocal automake' .github/scripts/setup-native-build-tools.sh ||
  fail "native CI setup must install automake/aclocal for PostGIS autogen builds"
grep -Fq 'require_brew_tool glibtoolize libtool' .github/scripts/setup-native-build-tools.sh ||
  fail "native CI setup must install GNU libtool for PostGIS autogen builds"
grep -Fq 'install_linux_tools()' .github/scripts/setup-native-build-tools.sh ||
  fail "native CI setup must install Linux build tools for liboliphaunt Linux release targets"
grep -Fq 'sudo apt-get install -y --no-install-recommends' .github/scripts/setup-native-build-tools.sh ||
  fail "native CI setup must use a minimal apt install for Linux native build tools"
grep -Fq 'ripgrep \' .github/scripts/setup-native-build-tools.sh ||
  fail "native CI setup must install ripgrep for Linux native build probes"
grep -Fq '.github/scripts/setup-native-build-tools.sh 2G' .github/workflows/ci.yml ||
  fail "CI liboliphaunt native lanes must use the shared native build tool setup"
grep -Fq 'tools/dev/setup-android-sdk.sh \' .github/actions/setup-android/action.yml ||
  fail "setup-android action must provision Android SDK packages through the shared setup-android-sdk tool"
if grep -Fq 'sdkmanager is required for Android SDK provisioning' .github/actions/setup-android/action.yml; then
  fail "setup-android action must bootstrap Android command-line tools on clean Linux builders instead of requiring a preinstalled sdkmanager"
fi
grep -Fq 'commandlinetools-${host_tag}-${cmdline_tools_version}_latest.zip' tools/dev/setup-android-sdk.sh ||
  fail "Android SDK setup must derive command-line tools URLs from the pinned host/version metadata"
grep -Fq '"ndk;${ndk_version}"' tools/dev/setup-android-sdk.sh ||
  fail "Android SDK setup must install the pinned NDK side-by-side package through sdkmanager"
grep -Fq '"cmake;${cmake_version}"' tools/dev/setup-android-sdk.sh ||
  fail "Android SDK setup must install the pinned Android CMake package through sdkmanager"
grep -Fq 'ANDROID_SDKMANAGER_INSTALL_ATTEMPTS' tools/dev/setup-android-sdk.sh ||
  fail "Android SDK setup must retry sdkmanager package installation for transient/corrupt downloads"
grep -Fq 'cleanup_partial_sdk_packages' tools/dev/setup-android-sdk.sh ||
  fail "Android SDK setup must clean partial sdkmanager package directories before retrying"
grep -Fq 'python3 tools/graph/ci_plan.py' .github/workflows/ci.yml ||
  fail "CI must derive product job startup from the Moon affected planner"
grep -Fq "contains(fromJson(needs.affected.outputs.jobs), 'liboliphaunt-wasix-runtime')" .github/workflows/ci.yml ||
  fail "CI must gate expensive WASIX runtime work from the Moon affected job list"
grep -Fq "contains(fromJson(needs.affected.outputs.jobs), 'liboliphaunt-wasix-aot')" .github/workflows/ci.yml ||
  fail "CI must gate expensive WASIX AOT work from the Moon affected job list"
grep -Fq "contains(fromJson(needs.affected.outputs.jobs), 'liboliphaunt-wasix-release-assets')" .github/workflows/ci.yml ||
  fail "CI must gate WASIX release asset aggregation from the Moon affected job list"
if [[ -e .github/workflows/assets.yml ]]; then
  fail "WASM runtime jobs must live in the main CI workflow, not a standalone assets workflow"
fi
grep -Fq 'exec "$moon_bin" run "$@"' .github/scripts/run-moon-targets.sh ||
  fail "planned artifact Moon helper must run selected targets through canonical moon run"
grep -Fq "bun .github/scripts/select-affected-moon-targets.mjs \"\$task\"" .github/scripts/run-affected-moon-task.sh ||
  fail "affected quality Moon helper must delegate target selection to the Bun selector"
grep -Fq "moon query tasks" .github/scripts/select-affected-moon-targets.mjs ||
  fail "affected quality Moon selector must ask Moon for affected task targets"
grep -Fq "'--id'" .github/scripts/select-affected-moon-targets.mjs ||
  fail "affected quality Moon selector must filter by task id"
if grep -Fq 'action-graph' .github/scripts/select-affected-moon-targets.mjs; then
  fail "affected quality Moon selector must not hide check/test targets behind build-lane action graphs"
fi
if grep -Fq 'OLIPHAUNT_SKIP_TARGETS_COVERED_BY_PLANNED_JOBS' .github/workflows/ci.yml .github/scripts/select-affected-moon-targets.mjs; then
  fail "checks/tests jobs must be visible as their own affected Moon targets"
fi
grep -Fq 'missing package-shape output' tools/release/build-sdk-ci-artifacts.sh ||
  fail "SDK artifact builder must consume package-shape outputs produced by Moon task deps"
if grep -Fq 'OLIPHAUNT_SDK_CHECK_SCRATCH="$work_root/check"' tools/release/build-sdk-ci-artifacts.sh; then
  fail "SDK artifact builder must not rerun package-shape inside the artifact staging script"
fi
grep -Fq 'tools/release/write_checksum_manifest.mjs \' tools/release/package-liboliphaunt-aggregate-assets.sh ||
  fail "aggregate liboliphaunt asset packager must use the shared Bun checksum manifest writer"
if grep -Fq 'python3 - "$asset_dir" "$checksum_file"' tools/release/package-liboliphaunt-aggregate-assets.sh; then
  fail "aggregate liboliphaunt asset packager must not embed inline Python for checksum manifests"
fi
grep -Fq '  ./${path.basename(asset)}' tools/release/write_checksum_manifest.mjs ||
  fail "shared release checksum writer must emit strict './asset' paths"
grep -Fq 'no release assets found' tools/release/write_checksum_manifest.mjs ||
  fail "shared release checksum writer must fail when no payload assets match"
grep -Fq 'upstream="${OLIPHAUNT_MOON_UPSTREAM:-deep}"' .github/scripts/run-affected-moon-task.sh ||
  fail "affected quality Moon helper must preserve Moon upstream task inheritance by default"
grep -Fq 'exec .github/scripts/run-moon-targets.sh --upstream "$upstream"' .github/scripts/run-affected-moon-task.sh ||
  fail "affected quality Moon helper must run exact selected targets through canonical moon run"
grep -Fq 'OLIPHAUNT_CI_JOB_TARGETS_JSON' .github/scripts/select-planned-moon-targets.mjs ||
  fail "planned CI Moon target selector must consume the affected planner target map"
grep -Fq 'bun .github/scripts/select-planned-moon-targets.mjs "$job"' .github/scripts/run-planned-moon-job.sh ||
  fail "planned CI Moon helper must delegate target selection to the Bun selector"
if grep -Fq 'pnpm moon' .github/scripts/run-moon-targets.sh; then
  fail "shared CI Moon helper must not launch Moon through pnpm"
fi
if grep -Fq 'pnpm moon' .github/scripts/run-affected-moon-task.sh .github/scripts/select-affected-moon-targets.mjs; then
  fail "affected quality Moon helper must not launch Moon through pnpm"
fi
grep -Fq 'Download liboliphaunt release assets' .github/workflows/release.yml ||
  fail "release workflow must download staged liboliphaunt assets instead of rebuilding native runtime artifacts"
grep -Fq 'Download native helper release assets' .github/workflows/release.yml ||
  fail "release workflow must download staged native helper assets instead of rebuilding helper artifacts"
grep -Fq '  rg \' tools/dev/doctor.sh ||
  fail "pnpm doctor must report the pinned ripgrep binary used by maintainer gates"
grep -Fq 'minimumReleaseAge: 1440' pnpm-workspace.yaml ||
  fail "pnpm workspace must retain a release-age delay for new registry versions"
grep -Fq 'saveWorkspaceProtocol: rolling' pnpm-workspace.yaml ||
  fail "pnpm workspace must preserve workspace:* when adding local package dependencies"
grep -Fq 'autoInstallPeers: false' pnpm-workspace.yaml ||
  fail "pnpm workspace must not auto-install peer dependencies into SDK library package locks"
grep -Fq 'updateNotifier: false' pnpm-workspace.yaml ||
  fail "pnpm workspace must suppress update-notifier output for quiet scripted installs"
grep -Fq 'verifyDepsBeforeRun: false' pnpm-workspace.yaml ||
  fail "pnpm run must not auto-install before command-card scripts; install is an explicit developer action"
grep -Fxq '/.moon/cache/' .gitignore ||
  fail ".moon/cache must remain ignored; Moon cache state is local generated data"
grep -Fq '  core-js: false' pnpm-workspace.yaml ||
  fail "pnpm workspace must explicitly review and ignore the core-js postinstall script"
for allowed_build in esbuild msgpackr-extract sharp unrs-resolver; do
  grep -Fq "  $allowed_build: true" pnpm-workspace.yaml ||
    fail "pnpm workspace must explicitly review and allow required install scripts from $allowed_build"
  grep -Fq "  $allowed_build: true" src/bindings/wasix-rust/tools/check-examples.sh ||
    fail "example scratch workspace must mirror required allowed install script from $allowed_build"
  grep -Fq "  $allowed_build: true" src/sdks/react-native/tools/check-sdk.sh ||
    fail "React Native SDK scratch workspace must mirror required allowed install script from $allowed_build"
  grep -Fq "  $allowed_build: true" src/sdks/js/tools/check-sdk.sh ||
    fail "TypeScript SDK scratch workspace must mirror required allowed install script from $allowed_build"
done
grep -Fq '  core-js: false' src/bindings/wasix-rust/tools/check-examples.sh ||
  fail "example scratch workspace must mirror the reviewed core-js postinstall decision"
grep -Fq '  core-js: false' src/sdks/react-native/tools/check-sdk.sh ||
  fail "React Native SDK scratch workspace must mirror the reviewed core-js postinstall decision"
grep -Fq '  core-js: false' src/sdks/js/tools/check-sdk.sh ||
  fail "TypeScript SDK scratch workspace must mirror the reviewed core-js postinstall decision"
grep -Fq '/tools/test/**/*' tools/policy/moon.yml ||
  fail "policy-tools Moon inputs must include shared test tooling"
grep -Fq 'target/liboliphaunt-sdk-check/oliphaunt-react-native' src/sdks/react-native/tools/check-sdk.sh ||
  fail "React Native SDK checks must use an isolated scratch root so Moon can run SDK checks in parallel"
grep -Fq 'target/liboliphaunt-sdk-check/oliphaunt-js' src/sdks/js/tools/check-sdk.sh ||
  fail "TypeScript SDK checks must use an isolated scratch root so Moon can run SDK checks in parallel"
grep -Fq 'cache-witness-fixture:' tools/graph/moon.yml ||
  fail "graph-tools must keep a cache witness fixture task"
grep -Fq 'bun tools/graph/cache-witness.mjs assert' tools/graph/moon.yml ||
  fail "graph-tools cache witness must use the Bun helper"
grep -Fq 'cacheStrategy: "outputs"' moon.yml ||
  fail "repo coverage aggregate must use Moon dependency cacheStrategy=outputs"
grep -Fq 'cacheStrategy: "outputs"' src/docs/moon.yml ||
  fail "docs generated-site consumers must use Moon dependency cacheStrategy=outputs"

for workspace in \
  'src/docs' \
  'src/sdks/react-native' \
  'src/sdks/js' \
  'src/sdks/react-native/examples/expo' \
  'src/bindings/wasix-rust/examples/tauri-sqlx-vanilla'
do
  grep -Fq "\"$workspace\"" pnpm-workspace.yaml ||
    fail "pnpm workspace is missing $workspace"
done

for biome_include in \
  '"src/sdks/react-native/typedoc.json"' \
  '"src/sdks/js/package.json"' \
  '"src/sdks/js/typedoc.json"' \
  '"src/sdks/js/jsr.json"' \
  '"src/sdks/js/src/**/*.ts"' \
  '"tools/test/**/*.mjs"'
do
  grep -Fq "$biome_include" biome.json ||
    fail "biome.json must include formatter/linter surface $biome_include"
done

node -e '
const fs = require("node:fs");
const root = JSON.parse(fs.readFileSync("package.json", "utf8"));
const actualScripts = Object.keys(root.scripts ?? {});
if (actualScripts.length !== 0) {
  console.error(`root package.json scripts must be empty; use moon directly, got ${actualScripts.join(", ")}`);
  process.exit(1);
}
const pkg = JSON.parse(fs.readFileSync("src/sdks/react-native/examples/expo/package.json", "utf8"));
if (pkg.dependencies?.["@oliphaunt/react-native"] !== "workspace:*") {
  console.error("Expo source example must depend on @oliphaunt/react-native with workspace:*; installed-package smoke scripts patch scratch copies to tarballs.");
  process.exit(1);
}
'

if git grep -n -E 'target/react-native-oliphaunt-expo|file:.*oliphaunt-react-native-[^[:space:]]*\.tgz' \
  -- package.json pnpm-lock.yaml src/sdks/react-native |
  grep -v '^tools/policy/check-tooling-stack.sh:' >/tmp/oliphaunt-rn-tarball-grep.$$ 2>/dev/null; then
  cat /tmp/oliphaunt-rn-tarball-grep.$$ >&2
  rm -f /tmp/oliphaunt-rn-tarball-grep.$$
  fail "generated React Native package tarballs must not be referenced by checked-in pnpm manifests or lockfiles"
fi
rm -f /tmp/oliphaunt-rn-tarball-grep.$$

if git grep -n -- '--no-lockfile' -- .github tools src/sdks/react-native src/sdks/js src/bindings/wasix-rust/examples/tauri-sqlx-vanilla |
  grep -v '^tools/policy/check-tooling-stack.sh:' >/tmp/oliphaunt-no-lockfile-grep.$$ 2>/dev/null; then
  cat /tmp/oliphaunt-no-lockfile-grep.$$ >&2
  rm -f /tmp/oliphaunt-no-lockfile-grep.$$
  fail "pnpm installs in tooling must use the root lockfile or a scratch lockfile, not --no-lockfile"
fi
rm -f /tmp/oliphaunt-no-lockfile-grep.$$

tracked_lockfiles="$(git ls-files '*package-lock.json' '*yarn.lock' '*bun.lockb' | while IFS= read -r path; do
  [ ! -e "$path" ] || printf '%s\n' "$path"
done)"
if [ -n "$tracked_lockfiles" ]; then
  printf '%s\n' "$tracked_lockfiles" >&2
  fail "JavaScript workspaces must use the root pnpm-lock.yaml"
fi

declare -a npm_policy_paths=()
while IFS= read -r path; do
  [ -n "$path" ] && npm_policy_paths+=("$path")
done < <(
  git ls-files .github tools src/sdks/react-native src/sdks/js src/bindings/wasix-rust/examples/tauri-sqlx-vanilla package.json pnpm-workspace.yaml |
    grep -E '(^|/)(package\.json|pnpm-workspace\.yaml)$|\.(sh|bash|zsh|mjs|cjs|js|ts|tsx|json|ya?ml)$'
)
if (( ${#npm_policy_paths[@]} > 0 )) &&
  git grep -n -E '(^|[^[:alnum:]_-])npm --prefix([[:space:]]|$)|(^|[^[:alnum:]_-])npm ci([[:space:]]|$)|(^|[^[:alnum:]_-])npm run([[:space:]]|$)|(^|[^[:alnum:]_-])npm pack([[:space:]]|$)|cache: npm|package-lock\.json' \
    -- "${npm_policy_paths[@]}" |
  grep -v '^tools/policy/check-tooling-stack.sh:' |
  grep -v '^tools/policy/check-docs.sh:' |
  grep -v '^tools/policy/check-repo-structure.sh:' >/tmp/oliphaunt-npm-grep.$$ 2>/dev/null; then
  cat /tmp/oliphaunt-npm-grep.$$ >&2
  rm -f /tmp/oliphaunt-npm-grep.$$
  fail "executable JavaScript tooling must use pnpm"
fi
rm -f /tmp/oliphaunt-npm-grep.$$

if git grep -n -E 'dirname "?\$\{BASH_SOURCE\[0\]\}"?.*/\.\./\.\.' -- src/runtimes/liboliphaunt/native/bin |
  grep -v '^src/runtimes/liboliphaunt/native/bin/common.sh:' >/tmp/oliphaunt-root-grep.$$ 2>/dev/null; then
  cat /tmp/oliphaunt-root-grep.$$ >&2
  rm -f /tmp/oliphaunt-root-grep.$$
  fail "native scripts must use src/runtimes/liboliphaunt/native/bin/common.sh for repo root resolution"
fi
rm -f /tmp/oliphaunt-root-grep.$$

if git grep -n -E 'git .*rev-parse --show-toplevel.*\|\| true|cd "\$[A-Za-z_][A-Za-z0-9_]*/(\.\./){3,}' -- \
  src/runtimes/liboliphaunt/wasix \
  src/extensions/artifacts/native \
  src/extensions/artifacts/wasix \
  src/extensions/external/postgis >/tmp/oliphaunt-ci-root-grep.$$ 2>/dev/null; then
  cat /tmp/oliphaunt-ci-root-grep.$$ >&2
  rm -f /tmp/oliphaunt-ci-root-grep.$$
  fail "CI runtime and extension artifact scripts must resolve the repo root from Git and fail closed"
fi
rm -f /tmp/oliphaunt-ci-root-grep.$$

tools/policy/assertions/assert-moon-task-policy.mjs

while IFS= read -r script; do
  case "$(head -n 1 "$script")" in
    '#!/usr/bin/env bash')
      bash -n "$script"
      ;;
    '#!/usr/bin/env sh')
      sh -n "$script"
      ;;
  esac
done < <(
  find .github tools src/runtimes/liboliphaunt/native/bin src/runtimes/liboliphaunt/wasix src/runtimes/node-direct/tools src/extensions/artifacts src/extensions/external/postgis \
    \( -path './.github/actions/*/node_modules' \) -prune -o \
    -type f -name '*.sh' -print |
    LC_ALL=C sort
)

if git ls-files |
  grep -E '(^|/)(node_modules|\.build|\.gradle|\.kotlin|\.cxx|\.next|\.source|\.expo|build|out|dist|web-build|Pods|DerivedData|__pycache__)/' |
  grep -v '^src/runtimes/liboliphaunt/wasix/assets/build/' >/tmp/oliphaunt-generated-grep.$$ 2>/dev/null; then
  cat /tmp/oliphaunt-generated-grep.$$ >&2
  rm -f /tmp/oliphaunt-generated-grep.$$
  fail "generated build/dependency directories must not be tracked"
fi
rm -f /tmp/oliphaunt-generated-grep.$$

if git ls-files tools/ci tools/product | grep -q .; then
  git ls-files tools/ci tools/product >&2
  fail "retired tools/ci and tools/product entrypoints must not be tracked"
fi

if git ls-files |
  grep -E '(^crates/|^sdks/|^liboliphaunt/|^assets/wasix-build/)' >/tmp/oliphaunt-root-product-alias-grep.$$ 2>/dev/null; then
  cat /tmp/oliphaunt-root-product-alias-grep.$$ >&2
  rm -f /tmp/oliphaunt-root-product-alias-grep.$$
  fail "root product aliases are retired; product source must live under src/"
fi
rm -f /tmp/oliphaunt-root-product-alias-grep.$$

while IFS= read -r executable; do
  case "$executable" in
    .github/scripts/*.sh | \
    examples/tools/* | \
    src/runtimes/liboliphaunt/native/bin/* | \
    src/runtimes/liboliphaunt/native/tools/* | \
    src/runtimes/broker/tools/* | \
    src/runtimes/node-direct/tools/* | \
    src/extensions/tools/* | \
	    src/extensions/external/*/tools/* | \
	    src/extensions/artifacts/native/tools/* | \
	    src/extensions/artifacts/packages/tools/* | \
	    src/extensions/artifacts/wasix/tools/* | \
    src/sdks/kotlin/gradlew | \
    src/sdks/kotlin/tools/* | \
    src/sdks/react-native/tools/* | \
    src/sdks/js/tools/* | \
    src/bindings/wasix-rust/tools/* | \
    src/sdks/rust/tools/* | \
    src/sdks/swift/tools/* | \
    src/runtimes/liboliphaunt/wasix/assets/build/*.sh | \
    src/runtimes/liboliphaunt/wasix/tools/* | \
    tools/coverage/* | \
    tools/dev/* | \
    tools/graph/* | \
    tools/perf/* | \
    tools/perf/matrix/* | \
    tools/policy/* | \
    tools/runtime/* | \
    tools/test/* | \
    tools/release/*)
      ;;
    *)
      echo "$executable" >&2
      fail "tracked executable is outside an allowed ownership bucket"
      ;;
  esac
done < <(git ls-files -s | awk '$1 ~ /^1007/ { print $4 }' | LC_ALL=C sort)

echo "tooling stack checks passed"

#!/usr/bin/env sh
set -eu

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

canonical_release_repo="f0rr0/oliphaunt"
canonical_release_url="https://github.com/$canonical_release_repo"

fail() {
  echo "$1" >&2
  exit 1
}

require_file() {
  [ -f "$1" ] || fail "missing required repository structure file: $1"
}

proto_version() {
  tool="$1"
  awk -F '=' -v tool="$tool" '
    $1 ~ "^[[:space:]]*" tool "[[:space:]]*$" {
      value=$2
      gsub(/^[[:space:]\"]+|[[:space:]\"]+$/, "", value)
      print value
      found=1
    }
    END { if (!found) exit 1 }
  ' .prototools
}

require_dir() {
  [ -d "$1" ] || fail "missing required repository structure directory: $1"
}

reject_tracked_under() {
  path="$1"
  tracked_existing="$(
    git ls-files -- "$path" | while IFS= read -r tracked_path; do
      [ ! -e "$tracked_path" ] || printf '%s\n' "$tracked_path"
    done
  )"
  if [ -n "$tracked_existing" ]; then
    echo "tracked files remain under retired path: $path" >&2
    printf '%s\n' "$tracked_existing" >&2
    exit 1
  fi
}

reject_existing_path() {
  path="$1"
  tracked_existing="$(
    git ls-files -- "$path" | while IFS= read -r tracked_path; do
      [ ! -e "$tracked_path" ] || printf '%s\n' "$tracked_path"
    done
  )"
  if [ -n "$tracked_existing" ]; then
    echo "generated path must not be tracked under the source tree: $path" >&2
    printf '%s\n' "$tracked_existing" >&2
    exit 1
  fi
}

reject_path() {
  path="$1"
  if [ -e "$path" ]; then
    echo "retired repository path must not exist: $path" >&2
    exit 1
  fi
}

require_text() {
  file="$1"
  text="$2"
  if ! grep -Fq -- "$text" "$file"; then
    echo "expected '$text' in $file" >&2
    exit 1
  fi
}

reject_text() {
  file="$1"
  text="$2"
  if grep -Fq -- "$text" "$file"; then
    echo "unexpected '$text' in $file" >&2
    exit 1
  fi
}

for path in \
  liboliphaunt \
  crates \
  sdks \
  assets \
  fixtures \
  assets/wasix-build \
  examples/react-native-oliphaunt-expo \
  examples/tauri-sqlx-vanilla \
  examples/build_pgdata_template.rs \
  src/extensions/recipes \
  src/liboliphaunt \
  src/oliphaunt-docs \
  src/oliphaunt-kotlin \
  src/oliphaunt-react-native \
  src/oliphaunt-rust \
  src/oliphaunt-swift \
  src/oliphaunt-ts \
  src/oliphaunt-wasix \
  src/third-party
do
  reject_tracked_under "$path"
done

for path in \
  tools/dev/smoke-react-native-expo-android.sh \
  tools/dev/smoke-react-native-expo-ios.sh \
  tools/dev/mobile-extension-runtime.sh
do
  reject_path "$path"
done

for path in \
  release-plz.toml \
  tools/ci/validate.sh \
  tools/graph/run-affected.py \
  tools/release/check_clean_consumer_installs.py \
  tools/release/check_consumer_install_readiness.py \
  tools/release/check_product_changelogs.py \
  tools/release/cliff.toml \
  tools/release/ensure_swiftpm_version_tag.py \
  tools/release/plan.py \
  tools/release/prepare_products.py \
  tools/release/product_release_notes.py \
  tools/release/product_version.py \
  tools/release/product_versions_from_ref.py \
  tools/release/release-graph.toml
do
  reject_tracked_under "$path"
done

for path in \
  src/target \
  src/runtimes/liboliphaunt/wasix/assets/build/build \
  src/runtimes/liboliphaunt/wasix/assets/build/work \
  src/sdks/swift/.build \
  src/sdks/kotlin/.gradle \
  src/sdks/kotlin/.kotlin \
  src/sdks/kotlin/build \
  src/sdks/kotlin/liboliphaunt-kotlin \
  src/sdks/kotlin/oliphaunt/.cxx \
  src/sdks/kotlin/oliphaunt/build \
  src/sdks/js/lib \
  src/sdks/js/node_modules \
  src/docs/node_modules \
  src/sdks/react-native/.build \
  src/sdks/react-native/lib \
  src/sdks/react-native/node_modules \
  src/sdks/react-native/android/.cxx \
  src/sdks/react-native/android/.gradle \
  src/sdks/react-native/android/build \
  src/sdks/react-native/examples/expo/.expo \
  src/sdks/react-native/examples/expo/node_modules \
  src/sdks/react-native/examples/expo/android \
  src/sdks/react-native/examples/expo/ios \
  src/docs/.docusaurus \
  src/docs/.next \
  src/docs/.source \
  src/docs/out \
  src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/dist \
  src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/src-tauri/gen
do
  reject_existing_path "$path"
done

for product in \
  src/runtimes/liboliphaunt/native \
  src/sdks/rust \
  src/sdks/swift \
  src/sdks/kotlin \
  src/sdks/react-native \
  src/sdks/js \
  src/bindings/wasix-rust \
  src/docs
do
  require_dir "$product"
  require_file "$product/moon.yml"
done

require_file .moon/workspace.yml
require_file .moon/toolchains.yml
require_file .prototools
require_file .config/nextest.toml
require_file .lychee.toml
require_file .markdownlint-cli2.jsonc
require_file .typos.toml
require_file biome.json
require_file renovate.json
require_file THIRD_PARTY_NOTICES.md
require_file package.json
require_file pnpm-lock.yaml
require_file pnpm-workspace.yaml
require_file release-please-config.json
require_file .release-please-manifest.json
require_file tools/release/release.py
require_file tools/dev/bun.sh
require_file tools/dev/doctor.sh
require_file tools/policy/check-policy-tools.sh
require_file tools/policy/check-final-source-architecture.py
require_file tools/graph/moon.yml
require_file tools/graph/graph.py
reject_path tools/graph/synthetic-paths.toml
require_file tools/graph/synthetic/affected.toml
require_file tools/graph/synthetic/release.toml
require_file tools/graph/synthetic/coverage.toml
require_file src/shared/contracts/moon.yml
require_file src/shared/contracts/test-matrix.toml
require_file src/shared/contracts/tools/check-test-matrix.py
require_file src/shared/fixtures/moon.yml
require_file src/shared/fixtures/manifest.toml
require_file .github/scripts/plan-affected.py
require_file .github/scripts/run-moon-ci.sh
require_file .github/scripts/run-moon-targets.sh
require_file src/runtimes/liboliphaunt/native/tools/check-patch-stack.mjs
require_file src/runtimes/liboliphaunt/native/THIRD_PARTY_NOTICES.md
require_file src/runtimes/liboliphaunt/wasix/tools/check-patch-stack.mjs
require_file src/bindings/wasix-rust/THIRD_PARTY_NOTICES.md
require_file tools/policy/check-react-native-boundary.sh
require_file tools/policy/check-sdk-mobile-extension-surface.sh
require_file tools/policy/check-test-strategy.mjs
require_file tools/policy/check-coverage.sh
require_file tools/policy/sdk-check-lib.sh
require_file tools/test/moon.yml
require_file tools/test/run-js-tests.mjs
require_file src/docs/package.json
require_file src/docs/next.config.mjs
require_file src/docs/source.config.ts
require_file src/docs/src/app/layout.tsx
require_file 'src/docs/src/app/(home)/page.tsx'
require_file src/docs/src/app/global.css
require_file src/docs/src/app/docs/layout.tsx
require_file 'src/docs/src/app/docs/[[...slug]]/page.tsx'
require_file src/docs/src/lib/source.ts
require_file src/docs/src/components/mdx.tsx
require_file src/docs/docs-manifest.toml
require_file tools/policy/sdk-manifest.toml
require_file src/docs/content/reference/sdk-products.mdx
require_file src/docs/reference/doxygen/Doxyfile
require_file src/docs/tools/generate-api-reference.mjs
require_file src/docs/tools/generate-content.mjs
require_file src/docs/tools/check-docs-product.mjs
require_file src/docs/tools/publish-next-export.mjs
require_file src/docs/tools/smoke-built-site.mjs
require_file tools/xtask/src/asset_manifest.rs
require_file tools/xtask/src/asset_checks.rs
require_file tools/xtask/src/asset_io.rs
require_file tools/xtask/src/asset_pipeline.rs
require_file tools/xtask/src/aot_serializer.rs
require_file tools/xtask/src/fs_utils.rs
require_file tools/perf/runner/Cargo.toml
require_file tools/perf/runner/src/benchmarks.rs
require_file tools/perf/runner/src/diagnostics.rs
require_file tools/perf/runner/src/legacy_wasix.rs
require_file tools/perf/runner/src/native_liboliphaunt.rs
require_file tools/perf/runner/src/native_postgres.rs
require_file tools/perf/runner/src/prepared_updates.rs
require_file tools/perf/runner/src/report.rs
require_file tools/perf/runner/src/shared.rs
require_file tools/perf/runner/src/sqlite.rs
require_file tools/xtask/src/postgres_guard.rs
require_file tools/xtask/src/release_workspace.rs
require_file tools/xtask/src/source_spine.rs
require_file tools/xtask/src/template_runner.rs
require_file src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/base/template_clone.rs
require_file src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/postgres_mod/stdio.rs
require_file src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/postgres_mod/wasix_fs.rs
require_file src/sdks/rust/src/runtime_resources/extension_artifact.rs
require_file src/sdks/rust/src/runtime_resources/extension_index.rs
require_file src/sdks/rust/src/runtime_resources/manifest.rs
require_file src/sdks/rust/src/runtime_resources/package.rs
require_file src/sdks/rust/src/runtime_resources/static_registry.rs
require_file src/extensions/contrib/postgres18.toml
require_file src/extensions/external/README.md
require_file src/extensions/external/vector/source.toml
require_file src/extensions/external/postgis/source.toml
require_file src/extensions/external/postgis/dependencies/geos/source.toml
require_file src/extensions/external/postgis/dependencies/proj/source.toml
require_file src/extensions/external/postgis/dependencies/sqlite/source.toml
require_file src/extensions/external/postgis/dependencies/libxml2/source.toml
require_file src/extensions/external/postgis/dependencies/json-c/source.toml
require_file src/extensions/external/postgis/dependencies/libiconv/source.toml
require_file src/extensions/schemas/recipe.schema.json
require_file src/extensions/schemas/support-table.schema.json
require_file src/extensions/evidence/matrix.toml
require_file src/extensions/evidence/schemas/matrix.schema.json
require_file src/extensions/evidence/schemas/run.schema.json
require_file src/extensions/evidence/runs/2026-06-07-transitional-catalog-smoke.json
require_file src/extensions/generated/docs/extensions.json
require_file src/extensions/generated/docs/extension-evidence.json
require_file src/extensions/generated/sdk/rust.json
require_file src/extensions/generated/sdk/swift.json
require_file src/extensions/generated/sdk/kotlin.json
require_file src/extensions/generated/sdk/js.json
require_file src/extensions/generated/sdk/react-native.json
require_file src/sdks/rust/src/generated/extensions.rs
require_file src/extensions/generated/mobile/static-registry.json
require_file src/extensions/generated/mobile/static-extensions.tsv
require_file src/extensions/generated/wasix/extensions.json
require_file src/extensions/tools/check-extension-model.py

require_dir src/sdks/rust/tests
require_dir src/sdks/swift/Tests
require_dir src/sdks/kotlin/oliphaunt/src/commonTest
require_dir src/sdks/kotlin/oliphaunt/src/androidUnitTest
require_dir src/sdks/kotlin/oliphaunt/src/nativeTest
require_dir src/sdks/react-native/src/__tests__
require_dir src/sdks/js/src/__tests__
require_dir src/bindings/wasix-rust/crates/oliphaunt-wasix/tests
require_file benchmarks/README.md
require_dir src/shared/fixtures/protocol
require_file src/shared/fixtures/protocol/query-response-cases.json
require_file src/shared/fixtures/sdk-capabilities/mode-support.json
require_file src/shared/fixtures/runtime-resources/manifest.properties
require_file src/shared/fixtures/runtime-resources/template-pgdata-manifest.properties
require_file src/shared/fixtures/runtime-resources/package-size.tsv
require_file src/shared/fixtures/backup/physical-archive-manifest.json
require_file src/shared/fixtures/lifecycle/session-lifecycle.json
require_file src/shared/fixtures/react-native-jsi/binary-transport.json
require_file src/shared/fixtures/consumer-shape/products.json
require_file coverage/baseline.toml

require_text .gitignore '/.moon/cache/'
pnpm_version="$(proto_version pnpm)"
require_text package.json "\"packageManager\": \"pnpm@$pnpm_version\""
require_text package.json '"node": ">=22.13 <25"'
require_text package.json "\"pnpm\": \"$pnpm_version\""
require_text pnpm-workspace.yaml 'nodeLinker: hoisted'
require_text pnpm-workspace.yaml 'confirmModulesPurge: false'
require_text pnpm-workspace.yaml 'updateNotifier: false'
require_text pnpm-workspace.yaml 'saveWorkspaceProtocol: rolling'
require_text pnpm-workspace.yaml 'verifyDepsBeforeRun: false'
node -e '
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const scripts = Object.keys(pkg.scripts ?? {});
if (scripts.length !== 0) {
  console.error(`root package.json scripts must be empty; use moon directly, got ${scripts.join(", ")}`);
  process.exit(1);
}
'
require_text .github/actions/setup-moon/action.yml 'moonrepo/setup-toolchain'
require_text .github/actions/setup-moon/action.yml 'auto-install: true'
require_text .github/actions/setup-moon/action.yml 'moon --version'
require_text .github/actions/setup-moon/action.yml 'bun --version'
require_text .github/actions/setup-moon/action.yml 'moon query projects'
reject_text .github/actions/setup-moon/action.yml 'pnpm moon'
reject_text .github/actions/setup-moon/action.yml 'node-version:'
reject_text .github/actions/setup-moon/action.yml 'pnpm-version:'
reject_tracked_under tools/graph/moon.mjs
reject_tracked_under tools/graph/tool-versions.mjs
reject_tracked_under tools/graph/tool_versions.py
reject_tracked_under tools/graph/run-affected-task.py
reject_tracked_under tools/policy/check-source-inputs.sh
reject_tracked_under tools/policy/check-source-inputs.mjs
require_file tools/policy/assertions/assert-source-inputs.mjs
require_text tools/policy/assertions/assert-source-inputs.mjs 'usage: assert-source-inputs.mjs'
require_text src/postgres/versions/18/moon.yml "bun tools/policy/assertions/assert-source-inputs.mjs postgres18"
require_text src/sources/moon.yml 'id: "source-inputs"'
require_text src/sources/moon.yml "bun tools/policy/fetch-sources.mjs"
require_text src/sources/toolchains/moon.yml "bun tools/policy/assertions/assert-source-inputs.mjs toolchains"
reject_text package.json 'pnpm moon'
reject_text package.json 'tools/graph/run-affected-task.py'
reject_text package.json '"docs:'
reject_text package.json '"check"'
reject_text package.json '"test"'
reject_text package.json '"coverage"'
reject_text package.json 'tools/graph/run-affected.py'
reject_text package.json '--affected --downstream deep'
reject_text package.json 'tools/dev/doctor.sh'
reject_text package.json 'tools/policy/format.sh'
reject_text package.json '"validate":'
reject_text package.json '"native:'
reject_text package.json '"rn:'
reject_text package.json '"wasix:'
reject_tracked_under tools/graph/run-affected.py
require_text .moon/workspace.yml 'moon.yml'
require_text .moon/workspace.yml 'sources:'
require_text .moon/workspace.yml 'ci-workflows: ".github"'
reject_text .moon/workspace.yml 'docs/moon.yml'
require_text .moon/workspace.yml 'examples/moon.yml'
require_text .moon/workspace.yml 'src/*/moon.yml'
require_text .moon/workspace.yml 'src/sources/*/moon.yml'
require_text .moon/workspace.yml 'src/sources/third-party/*/moon.yml'
require_text .moon/workspace.yml 'src/shared/*/moon.yml'
require_text .moon/workspace.yml 'tools/*/moon.yml'
require_text src/shared/contracts/moon.yml 'id: "shared-contracts"'
require_text src/shared/fixtures/moon.yml 'id: "shared-fixtures"'
require_text src/shared/fixtures/moon.yml 'target/shared-fixtures/manifest.generated.json'
require_text tools/policy/moon.yml 'tools/policy/check-policy-tools.sh'
require_text tools/policy/moon.yml '/tools/graph/**/*'
require_text tools/graph/moon.yml 'id: "graph-tools"'
require_text tools/graph/moon.yml 'tools/graph/graph.py check'
require_file tools/graph/cache-witness.py
require_text tools/graph/moon.yml 'cache-witness-fixture:'
require_text moon.yml 'cacheStrategy: "outputs"'
require_text src/docs/moon.yml 'cacheStrategy: "outputs"'
require_text tools/policy/moon.yml '/tools/test/**/*'
require_text src/sdks/rust/moon.yml 'dependsOn:'
require_text src/sdks/rust/moon.yml '- "liboliphaunt-native"'
require_text src/sdks/swift/moon.yml '- "liboliphaunt-native"'
require_text src/sdks/kotlin/moon.yml '- "liboliphaunt-native"'
require_text src/sdks/react-native/moon.yml '- "oliphaunt-swift"'
require_text src/sdks/react-native/moon.yml '- "oliphaunt-kotlin"'
require_text src/bindings/wasix-rust/moon.yml 'dependsOn:'
require_text src/bindings/wasix-rust/moon.yml '- "liboliphaunt-wasix"'
require_text src/runtimes/liboliphaunt/wasix/moon.yml 'id: "liboliphaunt-wasix"'
require_text src/runtimes/liboliphaunt/wasix/moon.yml '- "postgres18"'
require_text src/runtimes/liboliphaunt/wasix/moon.yml '- "source-toolchains"'
require_text src/runtimes/liboliphaunt/wasix/moon.yml '- "third-party-shared"'
require_text src/runtimes/liboliphaunt/wasix/moon.yml '- "third-party-wasix"'
require_text src/runtimes/liboliphaunt/wasix/moon.yml '- "extension-runtime-contract"'
require_text src/postgres/versions/18/moon.yml 'id: "postgres18"'
require_text src/sources/toolchains/moon.yml 'id: "source-toolchains"'
require_text src/sources/third-party/shared/moon.yml 'id: "third-party-shared"'
require_text src/sources/third-party/native/moon.yml 'id: "third-party-native"'
require_text src/sources/third-party/wasix/moon.yml 'id: "third-party-wasix"'
require_text src/extensions/moon.yml 'id: "extensions"'
require_text src/docs/moon.yml 'id: "docs"'
require_text src/docs/moon.yml 'pnpm --dir src/docs run check'

if git ls-files docs/products | grep -q .; then
  git ls-files docs/products >&2
  fail "root docs/products must stay retired; colocate product docs under src/<product>/docs"
fi

require_text Cargo.toml 'src/sdks/rust'
require_text Cargo.toml 'src/bindings/wasix-rust/crates/oliphaunt-wasix'
require_text Cargo.toml 'src/runtimes/liboliphaunt/wasix/crates/assets'
require_text Cargo.toml 'tools/perf/runner'
reject_text Cargo.toml '"crates/'
reject_text Cargo.toml '"sdks/'
require_text moon.yml '/tools/perf/runner/**/*.rs'
require_text moon.yml '/tools/perf/runner/Cargo.toml'
require_text tools/perf/moon.yml 'language: "rust"'
require_text tools/perf/moon.yml '/tools/perf/**/*'
require_text tools/xtask/moon.yml 'source-policy checks'
reject_text tools/xtask/moon.yml 'benchmark utilities'

require_text Cargo.toml "repository = \"$canonical_release_url\""
require_text .github/workflows/release.yml "CANONICAL_RELEASE_REPOSITORY: $canonical_release_repo"
require_text docs/maintainers/release.md "repository \`$canonical_release_repo\`"
reject_tracked_under .github/dependabot.yml
reject_tracked_under .github/workflows/conventional-commits.yml
reject_tracked_under .github/scripts/check-release-changelog.sh
require_text src/bindings/wasix-rust/crates/oliphaunt-wasix/release.toml 'id = "oliphaunt-wasix-rust"'
require_text release-please-config.json '"component": "oliphaunt-wasix-rust"'
reject_text .github/workflows/release.yml "f0rr0/oliphaunt-wasix"
reject_text .github/workflows/release.yml "Conventional Commits"
reject_text docs/maintainers/release.md "f0rr0/oliphaunt-wasix"

if git grep -n 'repository = "https://github.com/f0rr0/' -- '*.toml' |
  grep -Fv "repository = \"$canonical_release_url\"" >/tmp/oliphaunt-cargo-repo-url-grep.$$ 2>/dev/null; then
  cat /tmp/oliphaunt-cargo-repo-url-grep.$$ >&2
  rm -f /tmp/oliphaunt-cargo-repo-url-grep.$$
  fail "Cargo package repository URLs must point at $canonical_release_url"
fi
rm -f /tmp/oliphaunt-cargo-repo-url-grep.$$

if git grep -n 's.source = { :git => "https://github.com/f0rr0/' -- '*.podspec' |
  grep -Fv "https://github.com/$canonical_release_repo.git" >/tmp/oliphaunt-podspec-repo-url-grep.$$ 2>/dev/null; then
  cat /tmp/oliphaunt-podspec-repo-url-grep.$$ >&2
  rm -f /tmp/oliphaunt-podspec-repo-url-grep.$$
  fail "podspec source URLs must point at https://github.com/$canonical_release_repo.git"
fi
rm -f /tmp/oliphaunt-podspec-repo-url-grep.$$

reject_tracked_under .github/workflows/assets.yml
require_text .github/workflows/ci.yml 'src/runtimes/liboliphaunt/wasix/assets/build/**'
require_text .github/workflows/ci.yml 'src/postgres/versions/18/**'
require_text .github/workflows/ci.yml 'src/sources/third-party/**'
require_text .github/workflows/ci.yml 'src/sources/toolchains/**'
require_text .github/workflows/ci.yml 'src/shared/extension-runtime-contract/**'
require_text .github/workflows/ci.yml 'target/oliphaunt-wasix/wasix-build/build/**'
require_text .github/workflows/ci.yml 'name: Builds'
require_text .github/workflows/ci.yml 'name: build-native-runtime-desktop (${{ matrix.target }})'
require_text .github/workflows/ci.yml 'name: build-native-runtime-android (${{ matrix.target }})'
require_text .github/workflows/ci.yml 'name: build-native-runtime-ios (${{ matrix.target }})'
require_text .github/workflows/ci.yml 'name: build-liboliphaunt-wasix-runtime'
require_text .github/workflows/ci.yml 'name: build-liboliphaunt-wasix-aot (${{ matrix.target_id }})'
require_text .github/workflows/ci.yml 'python3 .github/scripts/plan-affected.py'
require_text .github/workflows/ci.yml 'name: build-plan'
require_text .github/workflows/ci.yml 'path: target/graph/ci-plan.json'
require_text .github/workflows/ci.yml 'job_targets: ${{ steps.plan.outputs.job_targets }}'
require_text .github/workflows/ci.yml 'liboliphaunt_wasix_aot_runtime_matrix: ${{ steps.plan.outputs.liboliphaunt_wasix_aot_runtime_matrix }}'
require_text .github/workflows/ci.yml 'matrix: ${{ fromJson(needs.affected.outputs.liboliphaunt_wasix_aot_runtime_matrix'
require_text .github/workflows/ci.yml "contains(fromJson(needs.affected.outputs.jobs), 'liboliphaunt-wasix-runtime')"
require_text .github/workflows/ci.yml "contains(fromJson(needs.affected.outputs.jobs), 'liboliphaunt-wasix-aot')"
require_text .github/workflows/ci.yml "contains(fromJson(needs.affected.outputs.jobs), 'liboliphaunt-wasix-release-assets')"
reject_text .github/workflows/ci.yml 'liboliphaunt-wasix-aot-targets'
require_text .github/workflows/ci.yml '.github/scripts/run-planned-moon-job.sh wasix-rust-package'
require_text .github/workflows/ci.yml 'liboliphaunt-wasix-runtime-portable'
require_text .github/workflows/ci.yml 'liboliphaunt-wasix-runtime-aot-${{ matrix.target_id }}'
require_text .github/scripts/run-planned-moon-job.sh 'OLIPHAUNT_CI_JOB_TARGETS_JSON'
require_text .github/scripts/run-planned-moon-job.sh 'exec .github/scripts/run-moon-targets.sh'
require_text .github/scripts/run-moon-ci.sh 'exec "$moon_bin" ci "$@"'
require_text .github/scripts/run-moon-targets.sh 'exec "$moon_bin" run "$@"'
reject_text .github/scripts/run-moon-ci.sh 'pnpm moon'
reject_text .github/scripts/run-moon-targets.sh 'pnpm moon'
require_text .github/scripts/plan-affected.py 'ci_plan.emit_github_outputs()'
require_text tools/graph/affected.py 'moon(["query", "affected", "--upstream", "none", "--downstream", "none"])'
require_text tools/graph/affected.py 'moon(["query", "affected", "--upstream", "none", "--downstream", "deep"])'
reject_path tools/graph/jobs.toml
reject_path tools/release/release-inputs.toml
require_text tools/graph/ci_plan.py 'moon_ci_job_targets'
require_text tools/graph/ci_plan.py 'ci-<job-id>'
require_text tools/graph/ci_plan.py 'job_targets_for_jobs'
reject_text tools/graph/ci_plan.py 'import plan as release_plan'
require_text tools/graph/graph.py 'import release_plan'
reject_text tools/graph/graph.py 'import plan as release_plan'
require_text tools/graph/ci_plan.py 'WASM_RUNTIME_PORTABLE_TASK'
require_text tools/graph/ci_plan.py 'WASM_RUNTIME_JOBS'
reject_text tools/graph/ci_plan.py 'PROJECT_JOBS = {'
reject_text tools/graph/ci_plan.py 'CI_JOB_TARGETS: dict[str, list[str]] = {'
reject_text tools/graph/ci_plan.py 'MOBILE_ANDROID_PATTERNS = ['
reject_text tools/graph/ci_plan.py 'RN_IOS_PLATFORM_PATTERNS = ['
require_text src/runtimes/liboliphaunt/wasix/moon.yml 'runtime-portable:'
reject_text tools/graph/ci_plan.py 'PRODUCER_PROJECTS'
reject_text tools/graph/ci_plan.py 'PRODUCER_TASKS'
reject_text .github/workflows/ci.yml 'producer_required'
reject_text .github/workflows/ci.yml 'asset-plan'
reject_text .github/workflows/ci.yml 'plan-wasix-assets.py'
reject_text .github/workflows/ci.yml '- "assets/**"'
reject_text .github/workflows/ci.yml 'src/runtimes/liboliphaunt/wasix/assets/build/build/**'
python3 - <<'PY'
from pathlib import Path

text = Path(".github/workflows/ci.yml").read_text()
head = text.split("push:", 1)[0]
if "paths:" in head:
    raise SystemExit("Builds pull_request trigger must not use path filters; Moon affected is the source of truth")
if (
    "liboliphaunt-wasix-runtime:" not in text
    or "liboliphaunt-wasix-aot:" not in text
):
    raise SystemExit("Builds workflow must keep separate liboliphaunt-wasix runtime and AOT builder jobs")
PY
require_text tools/xtask/src/main.rs 'target/oliphaunt-wasix/wasix-build/build/outputs.json'
require_text docs/maintainers/testing.md 'Product-native tests stay in product-native test roots'
require_text docs/maintainers/testing.md 'src/shared/fixtures/protocol/query-response-cases.json'
require_text docs/maintainers/testing.md 'src/shared/fixtures/sdk-capabilities/mode-support.json'
require_text docs/maintainers/testing.md 'src/shared/fixtures/react-native-jsi/binary-transport.json'
require_text docs/maintainers/testing.md 'coverage/baseline.toml'
require_text docs/maintainers/repo-structure.md 'Shared fixture corpora consumed by at least two product-native test suites'
require_text src/sdks/rust/tests/protocol_query_fixtures.rs 'query-response-cases.json'
require_text src/sdks/swift/Tests/OliphauntTests/ProtocolFixtureTests.swift 'query-response-cases.json'
require_text src/sdks/kotlin/oliphaunt/src/jvmTest/kotlin/dev/oliphaunt/SharedProtocolFixtureTest.kt 'query-response-cases.json'
require_text src/sdks/react-native/src/__tests__/protocol-fixtures.test.ts 'query-response-cases.json'
require_text src/sdks/react-native/package.json 'node ../../../tools/test/run-js-tests.mjs src/__tests__'
require_text src/sdks/react-native/src/__tests__/client.test.ts 'react-native-jsi/binary-transport.json'
require_text src/sdks/js/src/__tests__/protocol-fixtures.test.ts 'query-response-cases.json'
require_text src/sdks/js/package.json 'node ../../../tools/test/run-js-tests.mjs src/__tests__'
require_text src/sdks/js/tools/check-sdk.sh 'jsr publish --dry-run'
require_text src/bindings/wasix-rust/crates/oliphaunt-wasix/src/protocol/shared_fixture_tests.rs 'query-response-cases.json'
require_file benchmarks/native/sql/benchmark1.sql
require_file benchmarks/native/baselines/README.md
require_file benchmarks/wasix/README.md
require_file benchmarks/mobile/README.md
require_file benchmarks/reports/README.md
reject_tracked_under tools/perf/fixtures
reject_text tools/perf/matrix/run_bench_matrix.sh 'node-bench'
reject_text tools/perf/matrix/run_bench_matrix.sh 'bench-oxide'
reject_text tools/perf/matrix/run_bench_matrix.sh 'nodefs'
require_text docs/maintainers/tooling.md 'tools/xtask/src/template_runner.rs'
require_text docs/maintainers/tooling.md 'tools/xtask/src/asset_checks.rs'
require_text docs/maintainers/tooling.md 'tools/xtask/src/asset_manifest.rs'
require_text docs/maintainers/tooling.md 'tools/xtask/src/asset_io.rs'
require_text docs/maintainers/tooling.md 'tools/xtask/src/asset_pipeline.rs'
require_text docs/maintainers/tooling.md 'tools/xtask/src/fs_utils.rs'
require_text docs/maintainers/tooling.md 'tools/perf/runner/src/benchmarks.rs'
require_text docs/maintainers/tooling.md 'tools/perf/runner/src/diagnostics.rs'
require_text docs/maintainers/tooling.md 'tools/perf/runner/src/legacy_wasix.rs'
require_text docs/maintainers/tooling.md 'tools/perf/runner/src/native_liboliphaunt.rs'
require_text docs/maintainers/tooling.md 'tools/perf/runner/src/native_postgres.rs'
require_text docs/maintainers/tooling.md 'tools/perf/runner/src/prepared_updates.rs'
require_text docs/maintainers/tooling.md 'tools/perf/runner/src/report.rs'
require_text docs/maintainers/tooling.md 'tools/perf/runner/src/shared.rs'
require_text docs/maintainers/tooling.md 'tools/perf/runner/src/sqlite.rs'
require_text docs/maintainers/tooling.md 'tools/xtask/src/postgres_guard.rs'
require_text docs/maintainers/tooling.md 'tools/xtask/src/source_spine.rs'
require_text docs/maintainers/tooling.md 'src/sdks/rust/src/runtime_resources/extension_artifact.rs'
require_text docs/maintainers/tooling.md 'src/sdks/rust/src/runtime_resources/extension_index.rs'
require_text docs/maintainers/tooling.md 'src/sdks/rust/src/runtime_resources/manifest.rs'
require_text docs/maintainers/tooling.md 'src/sdks/rust/src/runtime_resources/package.rs'
require_text docs/maintainers/tooling.md 'src/sdks/rust/src/runtime_resources/static_registry.rs'
require_text docs/maintainers/tooling.md 'src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/base/template_clone.rs'
require_text docs/maintainers/tooling.md 'src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/postgres_mod/stdio.rs'
require_text docs/maintainers/tooling.md 'src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/postgres_mod/wasix_fs.rs'
require_text docs/maintainers/tooling.md 'tools/policy/check-sdk-mobile-extension-surface.sh'
require_text src/bindings/wasix-rust/tools/check-examples.sh '--target-dir target/oliphaunt-wasix-rust/examples/tauri-sqlx-vanilla/src-tauri'
require_text src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh 'oliphaunt_resolve_repo_root'
require_text src/runtimes/liboliphaunt/native/bin/common.sh 'git -C "$script_dir" rev-parse --show-toplevel'
python3 tools/policy/check-final-source-architecture.py --self-test

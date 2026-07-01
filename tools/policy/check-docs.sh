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

for required in \
  docs/README.md \
  docs/architecture/ios.md \
  docs/architecture/native-liboliphaunt.md \
  docs/maintainers/assets.md \
  docs/maintainers/development.md \
  docs/maintainers/tooling.md \
  docs/maintainers/repo-structure.md \
  docs/maintainers/release.md \
  docs/maintainers/release-setup.md \
  docs/maintainers/testing.md \
  docs/maintainers/extension-packaging-policy.md \
  docs/maintainers/rust-sdk-policy.md \
  docs/maintainers/sdk-api-surface.md \
  docs/maintainers/sdk-parity-policy.md \
  docs/maintainers/wasm-usage-legacy.md \
  docs/internal/PHYSICAL_ARCHIVE_FORMAT.md \
  docs/internal/OLIPHAUNT_TRACK_REVIEW.md \
  docs/internal/OLIPHAUNT_README.md \
  docs/internal/OLIPHAUNT_PATCH_STACK.md \
  docs/internal/WASIX_PATCH_STACK.md \
  docs/internal/PERFORMANCE.md \
  src/docs/docs-manifest.toml \
  src/docs/content/learn/native-runtime.mdx \
  src/docs/content/learn/mobile-stability.mdx \
  src/docs/content/learn/tauri.mdx \
  src/docs/content/reference/extensions.mdx \
  src/docs/content/reference/performance.mdx \
  tools/policy/sdk-manifest.toml \
  src/docs/content/reference/capabilities.mdx \
  src/docs/content/reference/sdk-products.mdx \
  src/docs/reference/doxygen/Doxyfile \
  src/docs/tools/generate-api-reference.mjs \
  src/docs/tools/run-docs-task.mjs \
  src/docs/content/sdk/react-native/architecture.mdx \
  src/docs/content/sdk/wasm/dump-restore.mdx \
  src/docs/content/sdk/wasm/runtime.mdx
do
  [[ -f "$required" ]] || fail "missing required maintainer/product doc: $required"
done

for docs_task in generate check build release-check; do
  grep -Fq "\"$docs_task\": \"node tools/run-docs-task.mjs $docs_task\"" src/docs/package.json ||
    fail "docs package task $docs_task must use the lock-aware docs task runner"
done
if grep -Fq '"test":' src/docs/package.json; then
  fail "docs package must not advertise a test script; docs validation is policy/check work"
fi

grep -Fq "const lockDir = path.join(generatedRoot, '.docs-task.lock')" src/docs/tools/run-docs-task.mjs ||
  fail "docs task runner must serialize generated Fumadocs/Next writes"

top_level_docs="$(git ls-files docs | grep -E '^docs/[^/]+\.md$' | grep -v '^docs/README\.md$' || true)"
if [[ -n "$top_level_docs" ]]; then
  echo "$top_level_docs" >&2
  fail "root docs/*.md is retired except docs/README.md; use docs/architecture, docs/maintainers, docs/internal, or src/docs"
fi

if git ls-files docs/products | grep -q .; then
  git ls-files docs/products >&2
  fail "consumer product docs must live under src/docs/content, not docs/products"
fi

product_local_docs="$(git ls-files 'src/*/docs/**' | grep -E '\.(md|mdx)$' | grep -v '^src/docs/' || true)"
if [[ -n "$product_local_docs" ]]; then
  echo "$product_local_docs" >&2
  fail "public SDK docs must be centralized under src/docs/content; product-local docs require an explicit package-shipped exception"
fi

pnpm --dir src/docs run check

if find docs -maxdepth 1 -type f -iname '*internal*' | grep -q .; then
  find docs -maxdepth 1 -type f -iname '*internal*' >&2
  fail "internal docs must live under docs/internal/"
fi

if [[ -f docs/OLIPHAUNT_TRACK_REVIEW.md ]]; then
  fail "track review and release blocker audits must live under docs/internal/"
fi

if grep -Fq '[DONE.md](DONE.md)' docs/maintainers/development.md ||
  grep -Fq '[TODO.md](TODO.md)' docs/maintainers/development.md; then
  fail "public development docs must link maintainer progress notes through docs/internal/"
fi

retired_docs_grep=(
  'docs/ASSETS.md'
  'docs/DEVELOPMENT.md'
  'docs/EXTENSIONS.md'
  'docs/IOS_ARCHITECTURE.md'
  'docs/MOBILE_STABILITY.md'
  'docs/NATIVE_OLIPHAUNT.md'
  'docs/PERFORMANCE.md'
  'docs/PG_DUMP.md'
  'docs/REACT_NATIVE.md'
  'docs/RELEASE.md'
  'docs/RELEASE_SETUP.md'
  'docs/REPO_STRUCTURE.md'
  'docs/RUNTIME.md'
  'docs/SDK_API_SURFACE.md'
  'docs/SDK_PARITY.md'
  'docs/TAURI.md'
  'docs/TESTING.md'
  'docs/TOOLING.md'
  'docs/USAGE.md'
  'docs/WASIX_RUNTIME.md'
)
retired_docs_args=()
for retired_doc in "${retired_docs_grep[@]}"; do
  retired_docs_args+=(-e "$retired_doc")
done
# The root README is intentionally pinned to the previous main-branch README
# until the Oliphaunt public README is ready. Its legacy docs links are allowed
# while the Oliphaunt-specific version lives under docs/internal/.
if git grep -n -F "${retired_docs_args[@]}" -- docs src tools .github .moon |
  grep -v '^tools/policy/check-docs\.sh:' >/tmp/docs-retired-grep.$$ 2>/dev/null; then
  cat /tmp/docs-retired-grep.$$ >&2
  rm -f /tmp/docs-retired-grep.$$
  fail "retired root docs paths remain referenced"
fi
rm -f /tmp/docs-retired-grep.$$

retired_tool_docs_grep=(
  'tools/release/sync_release_pr.py'
  'tools/release/artifact_target_matrix.py'
)
retired_tool_docs_args=()
for retired_tool_doc in "${retired_tool_docs_grep[@]}"; do
  retired_tool_docs_args+=(-e "$retired_tool_doc")
done
if git grep -n -F "${retired_tool_docs_args[@]}" -- docs/architecture docs/maintainers src/docs README.md |
  grep -v '^tools/policy/check-docs\.sh:' >/tmp/docs-retired-tool-grep.$$ 2>/dev/null; then
  cat /tmp/docs-retired-tool-grep.$$ >&2
  rm -f /tmp/docs-retired-tool-grep.$$
  fail "maintained docs must not point at retired Python release helpers"
fi
rm -f /tmp/docs-retired-tool-grep.$$

if grep -Fq 'Cargo publishing runs through `tools/release/release.py`' docs/maintainers/repo-structure.md; then
  fail "repo-structure maintainer docs must route Cargo publish guidance through the Bun release-publish entrypoint"
fi
if grep -Fq 'Those stay in `tools/release/release.py`' docs/maintainers/tooling.md; then
  fail "tooling maintainer docs must treat release.py as a protected implementation detail, not the public release command surface"
fi

if git grep -n \
  -e 'f0rr0/oliphaunt-oxide' \
  -e 'github.com/f0rr0/oliphaunt-oxide' \
  -- docs README.md src/*/README.md src/docs src/sdks/react-native/examples/expo/README.md src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/README.md |
  grep -v '^docs/internal/' >/tmp/docs-stale-grep.$$ 2>/dev/null; then
  cat /tmp/docs-stale-grep.$$ >&2
  rm -f /tmp/docs-stale-grep.$$
  fail "stale oliphaunt-oxide repository identity remains in public docs"
fi
rm -f /tmp/docs-stale-grep.$$

if git grep -n -E \
  -e '(^|[^[:alnum:]_-])npm --prefix' \
  -e '(^|[^[:alnum:]_-])npm run' \
  -e '(^|[^[:alnum:]_-])npm pack([[:space:];|&]|$)' \
  -e '(^|[^[:alnum:]_-])npm start' \
  -- README.md docs src/docs src/sdks/react-native/README.md src/sdks/react-native/examples/expo/README.md src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/README.md |
  grep -v '^docs/internal/' >/tmp/docs-npm-grep.$$ 2>/dev/null; then
  cat /tmp/docs-npm-grep.$$ >&2
  rm -f /tmp/docs-npm-grep.$$
  fail "public JavaScript docs must use pnpm workspace commands"
fi
rm -f /tmp/docs-npm-grep.$$

if git grep -n -E 'pnpm run moon --|pnpm run [[:alnum:]:-]+ -- --affected' \
  -- README.md docs src/*/README.md src/docs src/sdks/react-native/examples/expo/README.md src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/README.md >/tmp/docs-pnpm-args-grep.$$ 2>/dev/null; then
  cat /tmp/docs-pnpm-args-grep.$$ >&2
  rm -f /tmp/docs-pnpm-args-grep.$$
  fail "public pnpm script docs must not pass moon flags through an extra -- separator"
fi
rm -f /tmp/docs-pnpm-args-grep.$$

if git grep -n -E 'oliphaunt-wasix = (\{ version = )?"0\.4"' \
  -- docs src/docs src/bindings/wasix-rust/crates/oliphaunt-wasix/README.md >/tmp/docs-wasm-version-grep.$$ 2>/dev/null; then
  cat /tmp/docs-wasm-version-grep.$$ >&2
  rm -f /tmp/docs-wasm-version-grep.$$
  fail "public oliphaunt-wasix install snippets must use the current crate version"
fi
rm -f /tmp/docs-wasm-version-grep.$$

if git grep -n 'docs/assets/oliphaunt-wasix.png' \
  -- docs src/docs src/bindings/wasix-rust/crates/oliphaunt-wasix/README.md >/tmp/docs-wasm-image-grep.$$ 2>/dev/null; then
  cat /tmp/docs-wasm-image-grep.$$ >&2
  rm -f /tmp/docs-wasm-image-grep.$$
  fail "oliphaunt-wasix docs must not reference nonexistent local image assets"
fi
rm -f /tmp/docs-wasm-image-grep.$$

echo "documentation checks passed"

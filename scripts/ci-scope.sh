#!/usr/bin/env bash
set -euo pipefail

base_ref="${1:-}"
head_ref="${2:-HEAD}"

root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$root"

all_true=false
if [[ -z "$base_ref" ]] || ! git rev-parse --verify -q "$base_ref^{commit}" >/dev/null; then
  all_true=true
fi
if ! git rev-parse --verify -q "$head_ref^{commit}" >/dev/null; then
  all_true=true
fi

if [[ "$all_true" == true ]]; then
  changed_files="*"
else
  changed_files="$(git diff --name-only "$base_ref...$head_ref" --)"
fi

repo=false
rust=false
examples=false
package=false
assets=false
ci=false
docs=false

set_all_true() {
  repo=true
  rust=true
  examples=true
  package=true
  assets=true
  ci=true
  docs=true
}

if [[ "$changed_files" == "*" ]]; then
  set_all_true
else
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue

    case "$file" in
      .github/workflows/* | .github/scripts/* | .github/actions/* | .github/zizmor.yml | scripts/* | prek.toml | deny.toml | clippy.toml | rust-toolchain.toml)
        repo=true
        ci=true
        ;;
      .github/*)
        repo=true
        docs=true
        ;;
      README.md | CHANGELOG.md | docs/*)
        repo=true
        docs=true
        ;;
    esac

    case "$file" in
      Cargo.toml | build.rs | crates/*/Cargo.toml | crates/aot/*/Cargo.toml)
        repo=true
        rust=true
        package=true
        ;;
      Cargo.lock | src/* | tests/*)
        repo=true
        rust=true
        ;;
      xtask/*)
        repo=true
        rust=true
        assets=true
        ;;
    esac

    case "$file" in
      assets/* | crates/assets/* | crates/aot/*)
        repo=true
        rust=true
        assets=true
        ;;
    esac

    case "$file" in
      examples/*)
        repo=true
        examples=true
        ;;
    esac
  done <<< "$changed_files"
fi

if [[ "$assets" == true ]]; then
  rust=true
  package=true
fi

docs_only=false
if [[ "$docs" == true && "$rust" == false && "$examples" == false && "$package" == false && "$assets" == false && "$ci" == false ]]; then
  docs_only=true
fi

emit() {
  local key="$1"
  local value="$2"
  printf '%s=%s\n' "$key" "$value"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_OUTPUT"
  fi
}

emit repo "$repo"
emit rust "$rust"
emit examples "$examples"
emit package "$package"
emit assets "$assets"
emit ci "$ci"
emit docs "$docs"
emit docs_only "$docs_only"

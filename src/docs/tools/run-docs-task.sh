#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
task="${1:-}"
case "$task" in
  generate|check|build|release-check|api-reference) ;;
  *) echo 'usage: run-docs-task.sh generate|check|build|release-check|api-reference' >&2; exit 2 ;;
esac
mkdir -p ../../target/docs
lock=../../target/docs/.docs-task.lock
# ponytail: SIGKILL may leave this lock; remove it after confirming no docs task runs.
mkdir "$lock" 2>/dev/null || { echo "Another docs task owns $lock" >&2; exit 1; }
trap 'rmdir "$lock"' EXIT
export OLIPHAUNT_DOCS_GIT_SHA
OLIPHAUNT_DOCS_GIT_SHA="$(git rev-parse --short HEAD)"
if [ "$task" = api-reference ]; then
  moon run liboliphaunt-native:docs-api oliphaunt-rust:docs-api oliphaunt-swift:docs-api oliphaunt-kotlin:docs-api oliphaunt-react-native:docs-api oliphaunt-js:docs-api oliphaunt-wasix-rust:docs-api oliphaunt-wasix-ts:docs-api
  node tools/generate-api-reference.mts --mode=release
elif [ "$task" = release-check ]; then
  node tools/check-docs-product.mts --release
else
  if [ "$task" = generate ]; then
    node tools/generate-content.mts
  else
    node tools/check-docs-product.mts
  fi
  pnpm exec fumadocs-mdx
  case "$task" in
    check)
      pnpm exec next typegen
      pnpm exec fumadocs-mdx
      pnpm exec tsc --noEmit
      ;;
    build)
      pnpm exec next build
      pnpm exec fumadocs-mdx
      node tools/publish-next-export.mts
      ;;
  esac
fi

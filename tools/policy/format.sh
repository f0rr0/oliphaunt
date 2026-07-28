#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

mode="${1:---check}"
case "$mode" in
  --check) biome_args=(format); cargo_fmt_args=(--check) ;;
  --write) biome_args=(format --write); cargo_fmt_args=() ;;
  *) echo "usage: tools/policy/format.sh [--check|--write]" >&2; exit 2 ;;
esac

cargo fmt "${cargo_fmt_args[@]}"

# Biome owns JS/TS/JSON/CSS formatting. Other language-native formatters are
# wired through their product build files to avoid overlapping format engines.
pnpm --package=@biomejs/biome@2.4.16 dlx biome "${biome_args[@]}" \
  package.json \
  biome.json \
  renovate.json \
  .markdownlint-cli2.jsonc \
  src/docs/package.json \
  src/docs/next.config.mjs \
  src/docs/postcss.config.mjs \
  src/docs/proxy.ts \
  src/docs/source.config.ts \
  src/docs/src \
  src/docs/tools \
  src/sdks/react-native/package.json \
  src/sdks/react-native/typedoc.json \
  src/sdks/react-native/react-native.config.js \
  src/sdks/react-native/src \
  src/sdks/js/package.json \
  src/sdks/js/typedoc.json \
  src/sdks/js/jsr.json \
  src/sdks/js/src \
  tools/perf/matrix \
  tools/test

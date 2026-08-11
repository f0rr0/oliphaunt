#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

if git grep -n -E \
  -e 'pglite[-_]oxide' \
  -e 'github[.]com/f0rr0/(pglite|oliphaunt)-oxide' \
  -e 'PostgreSQL 17[.]5' \
  -- README.md CONTRIBUTING.md docs/architecture docs/maintainers src/docs src/*/README.md; then
  echo "public documentation contains a retired product or repository identity" >&2
  exit 1
fi

if git grep -n -F \
  -e 'tools/release/release.py' \
  -e 'tools/release/sync_release_pr.py' \
  -e 'tools/release/artifact_target_matrix.py' \
  -- README.md docs/architecture docs/maintainers src/docs; then
  echo "maintained documentation points at removed release tools" >&2
  exit 1
fi

if git grep -n -E \
  -e '(^|[^[:alnum:]_-])npm --prefix' \
  -e '(^|[^[:alnum:]_-])npm (run|pack|start)([[:space:];|&]|$)' \
  -- README.md CONTRIBUTING.md docs/architecture docs/maintainers src/docs src/*/README.md; then
  echo "public JavaScript instructions must use the pnpm workspace" >&2
  exit 1
fi

if git grep -n -E \
  -e 'pnpm run moon --' \
  -e 'pnpm run [[:alnum:]:-]+ -- --affected' \
  -- README.md CONTRIBUTING.md docs/architecture docs/maintainers src/docs src/*/README.md; then
  echo "public pnpm instructions contain an invalid extra argument separator" >&2
  exit 1
fi

echo "documentation examples are current"

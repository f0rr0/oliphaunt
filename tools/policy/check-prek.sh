#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"
PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"
export PATH

if ! command -v prek >/dev/null 2>&1; then
  echo "missing required command: prek" >&2
  echo "run tools/dev/bootstrap-tools.sh to install pinned maintainer tools" >&2
  exit 1
fi

printf '\n==> prek validate-config prek.toml\n'
prek validate-config prek.toml

printf '\n==> prek run --tracked-files --stage pre-commit\n'
git ls-files |
  while IFS= read -r file; do
    [ -e "$file" ] && printf '%s\0' "$file"
  done |
  xargs -0 prek run --stage pre-commit --files

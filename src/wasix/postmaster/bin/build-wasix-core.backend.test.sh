#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
builder="$project_root/bin/build-wasix-core.sh"

for unsupported in copied-fork fork typo; do
  set +e
  output="$(WASIX_CORE_CHILD_BACKEND="$unsupported" "$builder" --configure-only 2>&1)"
  status=$?
  set -e

  [ "$status" -eq 2 ] || {
    printf 'unsupported backend %s exited %s instead of 2\n' \
      "$unsupported" "$status" >&2
    exit 1
  }
  [ "$output" = "unsupported WASIX_CORE_CHILD_BACKEND=$unsupported; expected exec" ] || {
    printf 'unexpected unsupported-backend diagnostic for %s: %s\n' \
      "$unsupported" "$output" >&2
    exit 1
  }
done

printf 'WASIX core backend validation tests passed\n'

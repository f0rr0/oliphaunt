#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mode="${1:-}"
shift || true
case "$mode" in
  write)
    CI_CHECKED_OUT_SHA="$(git rev-parse --verify 'HEAD^{commit}')"
    CI_SOURCE_TREE="$(git rev-parse --verify 'HEAD^{tree}')"
    export CI_CHECKED_OUT_SHA
    ;;
  verify)
    CI_SOURCE_TREE="$(git rev-parse --verify --end-of-options "${RELEASE_HEAD_SHA:?RELEASE_HEAD_SHA is required}^{tree}")"
    ;;
  *) echo 'usage: release-candidate.sh write|verify [arguments]' >&2; exit 2 ;;
esac
export CI_SOURCE_TREE
exec bun "$script_dir/$mode-release-candidate.mts" "$@"

#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec bash "$root/tools/dev/bun.sh" test "$root/tools/release/snapshot-commit-paths.test.mts"

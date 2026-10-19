#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
for runtime in node bun deno electron; do
  bash smoke-node.sh --runtime "$runtime"
done

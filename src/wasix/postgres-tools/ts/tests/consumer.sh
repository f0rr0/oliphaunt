#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
for runtime in node bun deno; do
  bash smoke-host.sh --runtime "$runtime"
done

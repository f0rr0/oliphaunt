#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

tools/dev/bun.sh tools/policy/fetch-sources.mjs all --validate-only
tools/dev/bun.sh test tools/policy/source-fetch-core.test.mjs
bash src/postgres/versions/18/fetch-source.test.sh
bash src/runtimes/liboliphaunt/wasix/assets/build/docker/install-pinned-apt-packages.test.sh
bash src/runtimes/liboliphaunt/wasix/assets/build/docker/install-pinned-wasixcc.test.sh
bash tools/dev/setup-maestro.test.sh

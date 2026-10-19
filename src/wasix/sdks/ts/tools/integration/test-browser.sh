#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
bash smoke-browser.sh --postgis-worker
bash smoke-browser.sh --package-only

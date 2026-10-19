#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
command -v prek >/dev/null || { echo 'Install prek first: https://prek.j178.dev/installation/' >&2; exit 1; }
if [ "$(git config --local --get core.hooksPath || true)" = .githooks ]; then
  git config --local --unset core.hooksPath
fi
prek install --prepare-hooks --overwrite

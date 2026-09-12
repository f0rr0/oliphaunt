#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
head_ref=HEAD
args=("$@")
for ((index=0; index<${#args[@]}; index++)); do
  case "${args[index]}" in
    --head-ref)
      index=$((index + 1))
      head_ref="${args[index]:?--head-ref requires a value}" ;;
    --head-ref=*) head_ref="${args[index]#*=}" ;;
  esac
done
RELEASE_HEAD_COMMIT=$(git rev-parse --verify --end-of-options "$head_ref^{commit}")
export RELEASE_HEAD_COMMIT
bash tools/release/with-release-tags.sh bash tools/dev/bun.sh tools/release/check_release_versions.mts "$@"

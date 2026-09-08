#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
cd "$root"
packager=src/extensions/artifacts/native/tools/extension-artifact-packager.mts
stage_root=target/extensions/native/release-stage/local
args=("$@")
for ((index=0; index<${#args[@]}; index++)); do
  case "${args[index]}" in
    --stage-root) stage_root="${args[index+1]:?--stage-root requires a value}" ;;
    --stage-root=*) stage_root="${args[index]#*=}" ;;
  esac
done
mkdir -p "$stage_root"
stage="$(mktemp -d "$stage_root/.artifact.XXXXXXXX")"
trap 'rm -rf "$stage"' EXIT
bun "$packager" stage-artifact "$stage/artifact" "$@"
target="$(awk -F= '$1 == "nativeTarget" {print $2}' "$stage/artifact/manifest.properties")"
strip_args=()
if [ -n "$target" ]; then strip_args=(--target "$target"); fi
bash src/shared/artifact-packaging/strip-native-binaries.sh "${strip_args[@]}" "$stage/artifact"
bun "$packager" finish-artifact "$stage/artifact" "$@"

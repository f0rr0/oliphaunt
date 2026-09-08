#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
helper=src/runtimes/liboliphaunt/native/tools/stage-native-cluster-seed.mts
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
bun "$helper" prepare "$@" > "$scratch/arguments"
{
  IFS= read -r -d '' runtime
  IFS= read -r -d '' destination
  IFS= read -r -d '' target
  IFS= read -r -d '' profile
  IFS= read -r -d '' icu_data
} < "$scratch/arguments"
# Distributed seeds must not depend on the release runner's locale list.
unset OLIPHAUNT_EMBEDDED_MODULE_DIR ICU_DATA OLIPHAUNT_INTERNAL_ICU_READY
unset OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY OLIPHAUNT_ICU_DATA_DIR
export OLIPHAUNT_INSTALL_DIR="$runtime"
export OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY=1
args=(--output "$scratch/resources" --force --mode native-server)
if [ "$profile" = icu ]; then
  export OLIPHAUNT_ICU_DATA_DIR="$icu_data"
  args+=(--runtime-feature icu)
else
  export OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY=1
fi
cargo run -p oliphaunt-native-packaging --bin oliphaunt-resources --locked -- "${args[@]}"
bun "$helper" install "$scratch/resources/oliphaunt/cluster-seed" \
  --runtime "$runtime" --destination "$destination" --target "$target" --profile "$profile" \
  ${icu_data:+--icu-data} ${icu_data:+"$icu_data"}

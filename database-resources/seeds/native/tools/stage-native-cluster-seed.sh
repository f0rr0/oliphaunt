#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
helper=database-resources/seeds/native/tools/stage-native-cluster-seed.mts
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
export OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY=1
if [ "$profile" = icu ]; then
  export ICU_DATA="$icu_data"
  export OLIPHAUNT_INTERNAL_ICU_READY=1
else
  export OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY=1
fi
case "$(uname -s)" in
  Linux) export LD_LIBRARY_PATH="$runtime/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ;;
  Darwin) export DYLD_LIBRARY_PATH="$runtime/lib${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}" ;;
  MINGW*|MSYS*|CYGWIN*) export PATH="$runtime/bin:$runtime/lib:$PATH" ;;
esac
mkdir -p "$scratch/seed"
"$runtime/bin/initdb" -D "$scratch/seed/files" -U postgres --auth=trust \
  --locale-provider=libc --locale=C --encoding=UTF8 -L "$runtime/share/postgresql"
bun "$helper" install "$scratch/seed" \
  --runtime "$runtime" --destination "$destination" --target "$target" --profile "$profile" \
  ${icu_data:+--icu-data} ${icu_data:+"$icu_data"}

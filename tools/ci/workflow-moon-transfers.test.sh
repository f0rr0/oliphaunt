#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${OLIPHAUNT_MOON_TASK_GRAPH_FILE:?run through tools/ci/check-workflows.sh}"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
fixture=tools/ci/workflow-moon-transfers.test.mts
bash tools/dev/bun.sh test "./$fixture"
OLIPHAUNT_TRANSFER_FIXTURE_PHASE=prepare bash tools/dev/bun.sh "$fixture" "$scratch"
(
  cd "$scratch/postmaster-producer"
  RUNNER_TEMP="$scratch/postmaster-temp" bash -euo pipefail "$scratch/postmaster-produce.sh"
)
cp "$scratch/postmaster-temp/postmaster-native-linux-x64.tar.gz" \
  "$scratch/postmaster-consumer/target/oliphaunt-wasix-postmaster/native-input-download/"
(
  cd "$scratch/postmaster-consumer"
  bash -euo pipefail "$scratch/postmaster-restore.sh"
)
(
  cd "$scratch/postmaster-producer"
  rm target/oliphaunt-wasix-postmaster/runtime/build/wasmer-build.receipt
  if RUNNER_TEMP="$scratch/postmaster-temp" bash -euo pipefail "$scratch/postmaster-produce.sh" >/dev/null 2>&1; then
    echo 'native transfer must reject missing build receipts' >&2
    exit 1
  fi
)
for platform in android ios; do
  target=ios-xcframework
  [[ "$platform" != android ]] || target=android-x86_64
  (
    cd "$scratch/$platform/staged"
    NATIVE_ARTIFACT_ROOT="$PWD" RUNNER_TEMP="$scratch/$platform/temp" bash -euo pipefail "$scratch/$platform/produce.sh"
  )
  # GitHub normalizes the uploaded archive mode; its payload must retain original modes.
  chmod 644 "$scratch/$platform/temp/native-target.tar.gz"
  for consumer in "mobile-build-$platform" "liboliphaunt-native-$platform-abi"; do
    download=.
    [[ "$consumer" != *-abi ]] || download="target/liboliphaunt-native-ci/$target"
    cp "$scratch/$platform/temp/native-target.tar.gz" "$scratch/$consumer/$download/"
    (
      cd "$scratch/$consumer"
      bash -euo pipefail restore.sh
      [[ $("./target/liboliphaunt-mobile-host/$target/install/bin/postgres") == executable-host-tool ]]
    )
  done
done
OLIPHAUNT_TRANSFER_FIXTURE_PHASE=verify bash tools/dev/bun.sh "$fixture" "$scratch"

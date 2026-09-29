#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${OLIPHAUNT_MOON_TASK_GRAPH_FILE:?run through tools/ci/check-workflows.sh}"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
bash tools/dev/bun.sh test ./.github/scripts/resolve-planned-moon-execution.test.mts
resolver=.github/scripts/resolve-planned-moon-execution.mts
export OLIPHAUNT_CI_JOB_TARGETS_JSON='{"wasix-ts-sdk-package":["oliphaunt-wasix-ts:package","oliphaunt-wasix-ts:test-consumer","oliphaunt-wasix-ts:test-browser"]}'
export OLIPHAUNT_MOON_TRANSFERRED_DEPS_JSON='["liboliphaunt-wasix:runtime-portable","oliphaunt-wasix-napi:build-release-assets","extension-artifacts-wasix:compiler-output","database-resources:build-wasix-standard","database-resources:build-wasix-icu","database-resources:package-icu"]'
bash tools/dev/bun.sh "$resolver" wasix-ts-sdk-package | awk -F '\t' '{n=split($2, targets, " "); for(i=1;i<=n;i++) print $1 "\t" targets[i]}' >"$scratch/output"
for task in package test-consumer test-browser; do grep -Fx "$(printf 'target\toliphaunt-wasix-ts:%s' "$task")" "$scratch/output"; done
grep -Fx $'target\tdatabase-resources:package-wasix' "$scratch/output"
for variant in standard icu; do
  grep -Fx "$(printf 'transferred\tdatabase-resources:build-wasix-%s' "$variant")" "$scratch/output"
done
if grep -E $'^(local|target)\tdatabase-resources:build-wasix-' "$scratch/output"; then exit 1; fi
grep -Fx $'transferred\tliboliphaunt-wasix:runtime-portable' "$scratch/output"
for platform in android ios; do
  job="liboliphaunt-native-$platform-abi"
  root="database-resources:build-native-$platform-standard"
  targets=(ios-xcframework)
  [[ "$platform" != android ]] || targets=(android-arm64-v8a android-x86_64)
  export OLIPHAUNT_CI_JOB_TARGETS_JSON="{\"$job\":[\"$root\"]}"
  transfers='['
  printf 'target\t%s\n' "$root" >"$scratch/expected"
  for target in "${targets[@]}"; do
    transfers+="\"liboliphaunt-native:package-runtime-$target\",\"liboliphaunt-native:build-runtime-$target\","
    printf 'transferred\tliboliphaunt-native:build-runtime-%s\n' "$target" >>"$scratch/expected"
  done
  export OLIPHAUNT_MOON_TRANSFERRED_DEPS_JSON="${transfers%,}]"
  bash tools/dev/bun.sh "$resolver" "$job" | awk -F '\t' '{n=split($2, targets, " "); for(i=1;i<=n;i++) print $1 "\t" targets[i]}' >"$scratch/output"
  cmp "$scratch/expected" "$scratch/output"
done
export OLIPHAUNT_CI_JOB_TARGETS_JSON='{"react-native-sdk-package":["oliphaunt-react-native:test-consumer","oliphaunt-react-native:package"]}'
export OLIPHAUNT_MOON_TRANSFERRED_DEPS_JSON='["liboliphaunt-native:finalize-runtime-ios-abi"]'
bash tools/dev/bun.sh "$resolver" react-native-sdk-package | awk -F '\t' '{n=split($2, targets, " "); for(i=1;i<=n;i++) print $1 "\t" targets[i]}' >"$scratch/output"
grep $'^target\t' "$scratch/output" >"$scratch/targets"
printf 'target\toliphaunt-react-native:package\ntarget\toliphaunt-react-native:test-consumer\n' >"$scratch/expected"
cmp "$scratch/expected" "$scratch/targets"
if grep -E $'^local\t(oliphaunt-react-native:package|liboliphaunt-native:finalize-runtime-ios-abi)$' "$scratch/output"; then exit 1; fi
unset OLIPHAUNT_MOON_TRANSFERRED_DEPS_JSON
export OLIPHAUNT_CI_JOB_TARGETS_JSON='{"liboliphaunt-native-android":["liboliphaunt-native:package-runtime-android-arm64-v8a","liboliphaunt-native:package-runtime-android-x86_64"]}'
bash tools/dev/bun.sh "$resolver" liboliphaunt-native-android liboliphaunt-native:package-runtime-android-x86_64 | awk -F '\t' '{n=split($2, targets, " "); for(i=1;i<=n;i++) print $1 "\t" targets[i]}' >"$scratch/output"
printf 'target\tliboliphaunt-native:package-runtime-android-x86_64\n' >"$scratch/expected"
cmp "$scratch/expected" "$scratch/output"
if bash tools/dev/bun.sh "$resolver" liboliphaunt-native-android liboliphaunt-native:package-runtime-ios-xcframework >"$scratch/output" 2>"$scratch/error"; then
  echo 'accepted a target outside the job plan' >&2; exit 1
fi
grep -q 'is not planned' "$scratch/error"


# Prove the scheduling boundary with the pinned Moon binary: siblings overlap,
# their consumer waits for both, and a transferred producer must never execute.
mkdir -p "$scratch/parallel/.moon" "$scratch/parallel/.github/scripts"
cp .github/scripts/{run-planned-moon-job.sh,run-moon-targets.sh,resolve-planned-moon-execution.mts,select-planned-moon-targets.mts} "$scratch/parallel/.github/scripts/"
cat > "$scratch/parallel/.moon/workspace.yml" <<'YAML'
projects:
  fixture: .
YAML
cat > "$scratch/parallel/moon.yml" <<'YAML'
id: fixture
language: unknown
tasks:
  downloaded:
    script: exit 99
  a:
    command: bash sibling.sh a b
    deps: [downloaded]
  b:
    command: bash sibling.sh b a
    deps: [downloaded]
  joined:
    script: test -f a.done && test -f b.done && touch joined.done
    deps: [a, b]
YAML
cat > "$scratch/parallel/sibling.sh" <<'SH'
#!/usr/bin/env bash
set -eu
touch "$1.started"
for attempt in {1..100}; do
  [ ! -e "$2.started" ] || break
  sleep 0.1
done
test -f "$2.started"
touch "$1.done"
SH
(
  cd "$scratch/parallel"
  git init -q
  git -c user.name=fixture -c user.email=fixture@example.invalid commit -q --allow-empty -m fixture
  export OLIPHAUNT_CI_JOB_TARGETS_JSON='{"parallel":["fixture:joined"]}'
  export OLIPHAUNT_MOON_TRANSFERRED_DEPS_JSON='["fixture:downloaded"]'
  MOON_CONCURRENCY=2 bash .github/scripts/run-planned-moon-job.sh parallel
  test -f joined.done
)

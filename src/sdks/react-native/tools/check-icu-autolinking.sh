#!/usr/bin/env bash
set -euo pipefail
[ "$#" -eq 3 ] || { echo 'usage: check-icu-autolinking.sh REACT_NATIVE_TARBALL ICU_SOURCE EXPO_PROJECT' >&2; exit 2; }
root="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-autolinking.XXXXXX")"
trap 'rm -rf "$root"' EXIT
helper="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/icu-autolinking-fixture.mts"
expo_project="$(cd "$3" && pwd)"
bun "$helper" prepare "$root" "$1" "$2" "$expo_project"
mkdir "$root/packed"
PNPM_CONFIG_IGNORE_SCRIPTS=true pnpm --dir "$root/icu-source" pack --pack-destination "$root/packed" > /dev/null
archives=("$root/packed/"*.tgz)
[ "${#archives[@]}" -eq 1 ] && [ -f "${archives[0]}" ]
bun "$helper" extract "$root" "${archives[0]}"
consumer="$root/consumer"
cli="$(cat "$root/cli")"
for kind in candidate control; do
  if [ "$kind" = control ]; then bun "$helper" control "$root"; platforms=(ios); else platforms=(ios android); fi
  for platform in "${platforms[@]}"; do
    pnpm --dir "$expo_project" exec expo-modules-autolinking react-native-config "$consumer/node_modules" \
      --project-root "$consumer" --platform "$platform" --json > "$root/expo.json"
    bun "$helper" check "$root" "$kind" "$platform" "$root/expo.json"
    (cd "$consumer" && node "$cli" config --platform "$platform") > "$root/bare.json"
    bun "$helper" check "$root" "$kind" "$platform" "$root/bare.json"
  done
done
printf 'Packed React Native and ICU Expo/bare autolinking passed\n'

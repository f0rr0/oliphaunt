#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
bun test ./tools/packaging/windows-vc-runtime-closure.test.mts
scratch=$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-vc-strip-XXXXXX")
trap 'rm -rf "$scratch"' EXIT
bun tools/packaging/windows-vc-runtime-closure.test.mts prepare "$scratch"
cat > "$scratch/strip" <<'STRIP'
#!/usr/bin/env bash
set -euo pipefail
printf X >> "${!#}"
STRIP
chmod +x "$scratch/strip"
OLIPHAUNT_PE_STRIP="$scratch/strip" bash tools/packaging/strip-native-binaries.sh \
  --target windows-x64-msvc "$scratch/carrier" > "$scratch/strip.log" 2>&1
bun tools/packaging/windows-vc-runtime-closure.test.mts verify "$scratch"

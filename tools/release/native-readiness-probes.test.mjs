import { expect, test } from "bun:test";
import path from "node:path";

import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { ROOT } from "./release-graph.mjs";

const commonPath = path.join(
  ROOT,
  "src/runtimes/liboliphaunt/native/bin/common.sh",
);
const mobileStaticExtensionsPath = path.join(
  ROOT,
  "src/runtimes/liboliphaunt/native/bin/mobile-static-extensions.sh",
);

test("large Snowball symbol tables remain deterministic under pipefail", () => {
  const probe = String.raw`
set -euo pipefail
. "$1"
. "$2"

required_symbols='oliphaunt_builtin_dict_snowball_Pg_magic_func
dsnowball_init
pg_finfo_dsnowball_init
dsnowball_lexize
pg_finfo_dsnowball_lexize'

for symbol_prefix in '' '_'; do
  symbols="$({
    while IFS= read -r symbol; do
      printf '0000000000000000 T %s%s\n' "$symbol_prefix" "$symbol"
    done <<EOF
$required_symbols
EOF
    awk 'BEGIN { for (i = 0; i < 100000; i++) printf "%016x T unrelated_symbol_%06d_padding_padding_padding_padding_padding\n", i, i }'
  })"
  oliphaunt_mobile_builtin_snowball_linked_symbols_ready "$symbols"
done

while IFS= read -r omitted; do
  symbols="$({
    while IFS= read -r symbol; do
      [ "$symbol" = "$omitted" ] || printf '0000000000000000 T %s\n' "$symbol"
    done <<EOF
$required_symbols
EOF
  })"
  if oliphaunt_mobile_builtin_snowball_linked_symbols_ready "$symbols"; then
    echo "Snowball readiness accepted a payload without $omitted" >&2
    exit 1
  fi
done <<EOF
$required_symbols
EOF
`;

  const result = spawnSync(
    "bash",
    ["-c", probe, "bash", commonPath, mobileStaticExtensionsPath],
    { encoding: "utf8" },
  );

  expect(result.status, result.stderr).toBe(0);
});

test("native text probes use portable POSIX ERE bracket literals", () => {
  const probe = String.raw`
set -euo pipefail
. "$1"
dynamic_section=' 0x0000000000000001 (NEEDED)             Shared library: [liboliphaunt.so]'
oliphaunt_text_matches_ere "$dynamic_section" 'Shared library: [[]liboliphaunt[.]so[]]'
if oliphaunt_text_matches_ere "$dynamic_section" 'Shared library: [[]libother[.]so[]]'; then
  echo "native text probe accepted the wrong shared library" >&2
  exit 1
fi
device_metadata='      platform IOS'
simulator_metadata='      platform IOSSIMULATOR'
ios_device_pattern='(^|[[:space:]])platform[[:space:]]+IOS([[:space:]]|$)'
ios_simulator_pattern='(^|[[:space:]])platform[[:space:]]+IOSSIMULATOR([[:space:]]|$)'
oliphaunt_text_matches_ere "$device_metadata" "$ios_device_pattern"
oliphaunt_text_matches_ere "$simulator_metadata" "$ios_simulator_pattern"
if oliphaunt_text_matches_ere "$simulator_metadata" "$ios_device_pattern"; then
  echo "iOS device probe accepted an iOS simulator slice" >&2
  exit 1
fi
`;
  const result = spawnSync("bash", ["-c", probe, "bash", commonPath], {
    encoding: "utf8",
  });

  expect(result.status, result.stderr).toBe(0);
});

test("native log excerpts are line- and width-bounded", () => {
  const probe = String.raw`
set -euo pipefail
. "$1"
log="$2"
trap 'rm -f "$log"' EXIT
awk 'BEGIN { for (i = 1; i <= 100; i++) { printf "%03d ", i; for (j = 0; j < 5000; j++) printf "x"; printf "\n" } }' > "$log"
excerpt="$(oliphaunt_tail_log_excerpt "$log" 10 200)"
[ "$(printf '%s\n' "$excerpt" | awk 'END { print NR }')" -eq 10 ]
printf '%s\n' "$excerpt" | awk 'length($0) > 221 { exit 1 }'
`;
  const logPath = path.join(
    process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? "/tmp",
    `oliphaunt-native-readiness-${process.pid}.log`,
  );
  const result = spawnSync("bash", ["-c", probe, "bash", commonPath, logPath], {
    encoding: "utf8",
  });

  expect(result.status, result.stderr).toBe(0);
});

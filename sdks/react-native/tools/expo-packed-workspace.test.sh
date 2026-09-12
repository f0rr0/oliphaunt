#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-expo-packed.XXXXXX")"
trap 'rm -rf "$fixture"' EXIT
# shellcheck source=sdks/react-native/tools/expo-runner-common.sh
. "$root/sdks/react-native/tools/expo-runner-common.sh"
# shellcheck source=sdks/react-native/tools/expo-runner-workspace.sh
. "$root/sdks/react-native/tools/expo-runner-workspace.sh"
export OLIPHAUNT_EXPO_REQUIRE_SDK_ARTIFACTS=1
export OLIPHAUNT_EXPO_SDK_ARTIFACT_ROOT="$fixture/artifacts"
scratch_root="$fixture/consumer"
query_artifacts="$OLIPHAUNT_EXPO_SDK_ARTIFACT_ROOT/oliphaunt-query-ts"
mkdir -p "$query_artifacts" "$fixture/query" "$fixture/rn"
if (write_scratch_bun_workspace) >"$fixture/missing.log" 2>&1; then
  echo 'missing candidate query artifact unexpectedly accepted' >&2
  exit 1
fi
grep -Fq 'required SDK artifact for oliphaunt-query-ts' "$fixture/missing.log"
cat >"$fixture/query/package.json" <<'JSON'
{"name":"@oliphaunt/ts-query","version":"0.0.1","type":"module","exports":"./index.js"}
JSON
printf 'export const candidate = "packed-query";\n' >"$fixture/query/index.js"
bun pm pack --cwd "$fixture/query" --filename "$query_artifacts/query.tgz" >/dev/null
cat >"$fixture/rn/package.json" <<'JSON'
{"name":"@oliphaunt/react-native","version":"0.0.1","type":"module","exports":"./index.js","dependencies":{"@oliphaunt/ts-query":"0.0.1"}}
JSON
printf 'export { candidate } from "@oliphaunt/ts-query";\n' >"$fixture/rn/index.js"
bun pm pack --cwd "$fixture/rn" --filename "$fixture/rn.tgz" >/dev/null
write_scratch_bun_workspace
[ ! -e "$scratch_root/sdks/ts-query" ]
example_dir="$scratch_root/examples/react-native-expo"
mkdir -p "$example_dir"
printf '{"name":"react-native-oliphaunt-expo","private":true,"dependencies":{"picocolors":"^1.0.0"}}\n' >"$example_dir/package.json"
patch_expo_example_react_native_dependency "file:$fixture/rn.tgz"
install_expo_example_dependencies 2>&1 | tee -a "$fixture/install.log"
bun -e '
  const source = Bun.JSONC.parse(await Bun.file(process.argv[1]).text());
  const consumer = Bun.JSONC.parse(await Bun.file(process.argv[2]).text());
  if (JSON.stringify(source.packages.picocolors) !== JSON.stringify(consumer.packages.picocolors))
    throw new Error("locked registry version or integrity changed");
' "$root/bun.lock" "$scratch_root/bun.lock"
bun --cwd "$example_dir" -e '
  const { dirname, join } = await import("node:path");
  const { candidate } = await import("@oliphaunt/react-native");
  if (candidate !== "packed-query") throw new Error("did not load the query candidate");
  const rn = dirname(Bun.resolveSync("@oliphaunt/react-native", process.cwd()));
  const query = dirname(Bun.resolveSync("@oliphaunt/ts-query", rn));
  const declared = (await Bun.file(join(rn, "package.json")).json()).dependencies["@oliphaunt/ts-query"];
  if ((await Bun.file(join(query, "package.json")).json()).version !== declared)
    throw new Error("installed query version differs from the packed RN dependency");
'
cp "$scratch_root/bun.lock" "$fixture/first-consumer.lock"
write_scratch_bun_workspace
install_expo_example_dependencies 2>&1 | tee -a "$fixture/install.log"
cmp "$fixture/first-consumer.lock" "$scratch_root/bun.lock"
# Exercise the real Expo peer graph without compiling or running native apps.
scratch_root="$fixture/full-example-consumer"
write_scratch_bun_workspace
example_dir="$scratch_root/examples/react-native-expo"
mkdir -p "$example_dir"
cp "$root/examples/react-native-expo/package.json" "$example_dir/package.json"
patch_expo_example_react_native_dependency "file:$fixture/rn.tgz"
bun install --cwd "$scratch_root" --ignore-scripts --lockfile-only 2>&1 | tee -a "$fixture/install.log"
bun -e '
  const source = Bun.JSONC.parse(await Bun.file(process.argv[1]).text());
  const consumer = Bun.JSONC.parse(await Bun.file(process.argv[2]).text());
  const identity = row => JSON.stringify([row[0], row.at(-1)]);
  const pinned = new Set(Object.values(source.packages).map(identity));
  for (const row of Object.values(consumer.packages)) {
    if (typeof row[1] === "string" && typeof row.at(-1) === "string" && row.at(-1).startsWith("sha") && !pinned.has(identity(row)))
      throw new Error(`Expo registry version or integrity changed: ${row[0]}`);
  }
' "$root/bun.lock" "$scratch_root/bun.lock"
cp "$scratch_root/bun.lock" "$fixture/first-example.lock"
write_scratch_bun_workspace
bun install --cwd "$scratch_root" --ignore-scripts --lockfile-only 2>&1 | tee -a "$fixture/install.log"
cmp "$fixture/first-example.lock" "$scratch_root/bun.lock"
# The consumer must not acquire query merely because it exists in the checkout.
printf '{"name":"@oliphaunt/react-native","version":"0.0.1","type":"module","exports":"./index.js"}\n' >"$fixture/rn/package.json"
bun pm pack --cwd "$fixture/rn" --filename "$fixture/rn-missing-dependency.tgz" >/dev/null
if patch_expo_example_react_native_dependency "file:$fixture/rn-missing-dependency.tgz" >"$fixture/undeclared.log" 2>&1; then
  echo 'undeclared query dependency unexpectedly accepted' >&2
  exit 1
fi
grep -Fq 'does not satisfy packed RN dependency' "$fixture/undeclared.log"
printf '{"name":"@oliphaunt/react-native","version":"0.0.1","type":"module","exports":"./index.js","dependencies":{"@oliphaunt/ts-query":"0.0.2"}}\n' >"$fixture/rn/package.json"
bun pm pack --cwd "$fixture/rn" --filename "$fixture/rn-wrong-query.tgz" >/dev/null
if patch_expo_example_react_native_dependency "file:$fixture/rn-wrong-query.tgz" >"$fixture/mismatch.log" 2>&1; then
  echo 'mismatched query candidate unexpectedly accepted' >&2
  exit 1
fi
grep -Fq 'query candidate 0.0.1 does not satisfy packed RN dependency 0.0.2' "$fixture/mismatch.log"
if grep -Eq 'InvalidLockfile|Ignoring lockfile' "$fixture/install.log"; then
  echo 'consumer installation discarded its pinned registry lock' >&2
  exit 1
fi
echo 'Packed Expo consumer resolves declared candidate dependencies and rejects missing inputs'

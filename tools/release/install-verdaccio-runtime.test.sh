#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)"
installer="$root/tools/release/install-verdaccio-runtime.sh"
scratch="$(mktemp -d)"
fixture="$scratch/repository"
store="$scratch/store"
verdaccio_pid=""
cleanup() {
  if [[ -n "$verdaccio_pid" ]] && kill -0 "$verdaccio_pid" 2>/dev/null; then
    kill "$verdaccio_pid" 2>/dev/null || true
    wait "$verdaccio_pid" 2>/dev/null || true
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$fixture"
cp \
  "$root/tools/release/verdaccio-runtime/package.json" \
  "$root/tools/release/verdaccio-runtime/pnpm-lock.yaml" \
  "$fixture/"

run_installer() {
  env \
    OLIPHAUNT_VERDACCIO_TESTING=1 \
    OLIPHAUNT_VERDACCIO_RUNTIME_ROOT="$fixture" \
    OLIPHAUNT_VERDACCIO_STORE_DIR="$store" \
    "$@" \
    bash "$installer"
}

cold_version="$(run_installer)"
[[ "${cold_version##*$'\n'}" == "6.8.0" ]] || {
  echo "cold Verdaccio install did not resolve exact version 6.8.0" >&2
  exit 1
}
[[ -e "$fixture/node_modules/.bin/verdaccio" || -e "$fixture/node_modules/.bin/verdaccio.cmd" ]] || {
  echo "isolated Verdaccio install did not create its runtime-local executable" >&2
  exit 1
}
[[ ! -e "$fixture/src" ]] || {
  echo "isolated Verdaccio install unexpectedly hydrated workspace packages" >&2
  exit 1
}

port="$(node <<'JS'
const net = require("node:net");
const server = net.createServer();
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(String(server.address().port));
  server.close();
});
JS
)"
registry_url="http://127.0.0.1:$port"
config="$scratch/verdaccio.yaml"
storage="$scratch/verdaccio-storage"
htpasswd="$scratch/htpasswd"
node - "$config" "$storage" "$htpasswd" <<'JS'
const fs = require("node:fs");
const yamlString = (value) => JSON.stringify(value);
const [, , config, storage, htpasswd] = process.argv;
fs.mkdirSync(storage, { recursive: true });
fs.writeFileSync(config, [
  `storage: ${yamlString(storage)}`,
  "auth:",
  "  htpasswd:",
  `    file: ${yamlString(htpasswd)}`,
  "uplinks: {}",
  "packages:",
  "  '@oliphaunt/*':",
  "    access: $all",
  "    publish: $authenticated",
  "    unpublish: $authenticated",
  "    proxy: false",
  "  '**':",
  "    access: $all",
  "    publish: $authenticated",
  "    unpublish: $authenticated",
  "    proxy: false",
  "middlewares:",
  "  audit:",
  "    enabled: false",
  "log: {type: stdout, format: pretty, level: warn}",
  "",
].join("\n"));
JS
pnpm --dir "$fixture" exec verdaccio \
  --config "$config" \
  --listen "$registry_url" \
  >"$scratch/verdaccio.log" 2>&1 &
verdaccio_pid="$!"
ready=0
for _ in {1..60}; do
  if pnpm ping \
    --registry "$registry_url" \
    >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$verdaccio_pid" 2>/dev/null; then
    echo "Verdaccio exited before accepting registry requests" >&2
    sed -n '1,160p' "$scratch/verdaccio.log" >&2
    exit 1
  fi
  sleep 0.1
done
[[ "$ready" == "1" ]] || {
  echo "Verdaccio did not accept registry requests" >&2
  sed -n '1,160p' "$scratch/verdaccio.log" >&2
  exit 1
}

username="oliphaunt-runtime-test"
token="$(node - "$registry_url" "$username" <<'JS'
const [, , registryUrl, username] = process.argv;
void (async () => {
  const response = await fetch(`${registryUrl}/-/user/org.couchdb.user:${username}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: username,
      password: "oliphaunt-runtime-test",
      email: "runtime-test@oliphaunt.invalid",
      type: "user",
      roles: [],
    }),
  });
  if (!response.ok) throw new Error(`user creation failed with HTTP ${response.status}: ${await response.text()}`);
  const body = await response.json();
  if (typeof body.token !== "string" || body.token.length === 0) throw new Error("user response omitted token");
  process.stdout.write(body.token);
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
JS
)"
npmrc="$scratch/npmrc"
node - "$npmrc" "$registry_url" "$token" <<'JS'
const fs = require("node:fs");
const [, , npmrc, registryUrl, token] = process.argv;
const host = registryUrl.replace(/^https?:\/\//u, "");
fs.writeFileSync(npmrc, `registry=${registryUrl}/\n//${host}/:_authToken=${token}\n`);
JS

pnpm_registry() {
  env \
    NPM_CONFIG_FETCH_RETRIES=0 \
    NPM_CONFIG_LOGLEVEL=error \
    NPM_CONFIG_PROVENANCE=false \
    NPM_CONFIG_REGISTRY="$registry_url" \
    NPM_CONFIG_USERCONFIG="$npmrc" \
    pnpm "$@"
}

package_dir="$scratch/package"
tarball_dir="$scratch/tarballs"
mkdir -p "$package_dir" "$tarball_dir"
node - "$package_dir/package.json" <<'JS'
const fs = require("node:fs");
fs.writeFileSync(process.argv[2], `${JSON.stringify({
  name: "@oliphaunt/verdaccio-runtime-smoke",
  version: "0.0.0-test",
  files: ["index.js"],
}, null, 2)}\n`);
JS
node - "$package_dir/index.js" <<'JS'
require("node:fs").writeFileSync(process.argv[2], "module.exports = 'ok';\n");
JS
pack_json="$(pnpm --dir "$package_dir" pack --pack-destination "$tarball_dir" --json)"
tarball="$(node -e '
const rows = JSON.parse(process.argv[1]);
const row = Array.isArray(rows) ? rows[0] : rows;
if (typeof row?.filename !== "string" || row.filename.length === 0) process.exit(1);
process.stdout.write(row.filename);
' "$pack_json")"
[[ "$tarball" = /* ]] || tarball="$tarball_dir/$tarball"
pnpm_registry publish "$tarball" \
  --ignore-scripts \
  --access public \
  --no-git-checks \
  >/dev/null
observed_version="$(pnpm_registry view \
  "@oliphaunt/verdaccio-runtime-smoke@0.0.0-test" \
  version)"
[[ "$observed_version" == "0.0.0-test" ]] || {
  echo "Verdaccio view returned $observed_version instead of 0.0.0-test" >&2
  exit 1
}
pnpm_registry unpublish "@oliphaunt/verdaccio-runtime-smoke@0.0.0-test" \
  --force \
  >/dev/null
if pnpm_registry view \
  "@oliphaunt/verdaccio-runtime-smoke@0.0.0-test" \
  version \
  >/dev/null 2>&1; then
  echo "Verdaccio package remained visible after unpublish" >&2
  exit 1
fi

kill "$verdaccio_pid" 2>/dev/null || true
wait "$verdaccio_pid" 2>/dev/null || true
verdaccio_pid=""

rm -rf "$fixture/node_modules"
offline_version="$({
  NPM_CONFIG_REGISTRY=http://127.0.0.1:9 \
    run_installer OLIPHAUNT_VERDACCIO_OFFLINE=1
})"
[[ "${offline_version##*$'\n'}" == "6.8.0" ]] || {
  echo "offline Verdaccio reinstall did not resolve exact version 6.8.0" >&2
  exit 1
}

node - "$fixture/package.json" <<'JS'
const fs = require("node:fs");
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
manifest.dependencies.picomatch = "4.0.3";
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
JS
if run_installer OLIPHAUNT_VERDACCIO_OFFLINE=1 >"$scratch/frozen.stdout" 2>"$scratch/frozen.stderr"; then
  echo "Verdaccio runtime installer accepted a manifest that disagrees with the frozen lock" >&2
  exit 1
fi
if ! grep -Eq 'ERR_PNPM_OUTDATED_LOCKFILE|frozen lockfile' "$scratch/frozen.stdout" "$scratch/frozen.stderr"; then
  echo "Verdaccio runtime installer did not fail through frozen-lock validation" >&2
  sed -n '1,160p' "$scratch/frozen.stdout" >&2
  sed -n '1,160p' "$scratch/frozen.stderr" >&2
  exit 1
fi

echo "Verdaccio runtime cold, offline, frozen-lock, and registry lifecycle tests passed"

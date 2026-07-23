import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { captureCommandOutput } from "../dev/capture-command-output.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const EPOCH = 1_776_193_981;

function read(relative) {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

function sliceBetween(text, start, end) {
  const startIndex = text.indexOf(start);
  assert.notEqual(startIndex, -1, `missing start marker ${start}`);
  const endIndex = text.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing end marker ${end}`);
  return text.slice(startIndex, endIndex);
}

function assertOrdered(text, first, second, label) {
  const firstIndex = text.indexOf(first);
  const secondIndex = text.indexOf(second);
  assert.notEqual(firstIndex, -1, `${label} is missing ${first}`);
  assert.notEqual(secondIndex, -1, `${label} is missing ${second}`);
  assert.ok(firstIndex < secondIndex, `${label} must run ${first} before ${second}`);
}

test("PostGIS source pin carries one portable epoch tied to its exact commit", () => {
  const manifest = Bun.TOML.parse(read("src/extensions/external/postgis/source.toml"));
  assert.equal(manifest.name, "postgis");
  assert.equal(manifest.commit, "3d12666588a84b23a3147618eaa9b40b0fe5e796");
  assert.equal(manifest.source_date_epoch, EPOCH);
  assert.ok(manifest.source_date_epoch > 0 && manifest.source_date_epoch <= 253_402_300_799);

  const checkout = path.join(ROOT, "target/oliphaunt-sources/checkouts/postgis");
  if (existsSync(path.join(checkout, ".git"))) {
    const result = captureCommandOutput(
      "git",
      ["-C", checkout, "show", "-s", "--format=%ct", "HEAD"],
      {
        label: "read pinned PostGIS source timestamp",
        maxOutputBytes: 1024,
      },
    );
    assert.equal(
      result.error,
      undefined,
      result.error?.message ?? "git timestamp probe failed to start",
    );
    assert.equal(result.signal, null, `git timestamp probe received ${result.signal}`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Number.parseInt(result.stdout.trim(), 10), EPOCH);
  }
});

test("portable date shim owns GNU-only PostGIS formatting and delegates everything else", () => {
  const helper = read("src/extensions/external/postgis/tools/reproducible-time.sh");
  const shim = read("src/extensions/external/postgis/tools/reproducible-bin/date");
  assert.match(helper, /SOURCE_DATE_EPOCH="\$\(oliphaunt_postgis_source_date_epoch/u);
  assert.doesNotMatch(helper, /SOURCE_DATE_EPOCH:-/u);
  assert.match(helper, /253402300799/u);
  assert.match(shim, /\+%Y-%m-%d %H:%M:%S/u);
  assert.match(shim, /perl -MPOSIX=strftime/u);
  assert.match(shim, /exec "\$real_date" "\$@"/u);
});

test("every POSIX PostGIS producer enables canonical time before generation", () => {
  const mobile = read("src/runtimes/liboliphaunt/native/bin/mobile-postgis-extensions.sh");
  const mobileBuild = sliceBetween(
    mobile,
    "build_postgis_mobile_static_extension_objects() {",
    "oliphaunt_postgis_extra_link_args() {",
  );
  assertOrdered(
    mobileBuild,
    "oliphaunt_postgis_enable_reproducible_time",
    "./autogen.sh",
    "mobile PostGIS producer",
  );
  assert.match(mobile, /ios-simulator \| ios-device \| macos-arm64/u);

  for (const [file, endMarker, label] of [
    [
      "src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh",
      "build_native_extension_artifacts() {",
      "Linux PostGIS producer",
    ],
    [
      "src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh",
      "build_embedded_plpgsql_module() {",
      "macOS PostGIS producer",
    ],
  ]) {
    const producer = sliceBetween(read(file), "build_postgis_extension() {", endMarker);
    assertOrdered(
      producer,
      "oliphaunt_postgis_enable_reproducible_time",
      "./autogen.sh",
      label,
    );
  }

  const wasix = read("src/extensions/external/postgis/tools/build_wasix.sh");
  assertOrdered(
    wasix,
    "oliphaunt_postgis_enable_reproducible_time",
    "./autogen.sh",
    "WASIX PostGIS producer",
  );
  assert.match(wasix, /source_date_epoch=\$source_date_epoch/u);
  assert.match(wasix, /reproducible_date_shim=\$date_shim_sha256/u);
});

test("mobile and desktop producer stamps own the canonical time inputs", () => {
  for (const file of [
    "src/runtimes/liboliphaunt/native/bin/build-postgres18-android-arm64.sh",
    "src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-device.sh",
    "src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-simulator.sh",
    "src/runtimes/liboliphaunt/native/bin/build-macos-extension-archives.sh",
    "src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh",
    "src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh",
  ]) {
    const producer = read(file);
    assert.match(producer, /postgis_source_date_epoch/u, file);
    assert.match(producer, /reproducible-time\.sh/u, file);
    assert.match(producer, /reproducible-bin\/date/u, file);
  }
});

test("Windows generation uses the same epoch for templates and every Perl generator", () => {
  const windows = read("src/runtimes/liboliphaunt/native/bin/build-postgres18-windows.ps1");
  assert.doesNotMatch(windows, /Get-Date/u);
  assert.match(windows, /function Get-PostgisSourceDateEpoch/u);
  assert.match(windows, /function Format-PostgisSourceDate/u);
  assert.match(windows, /\$env:SOURCE_DATE_EPOCH = \[string\]\(Get-PostgisSourceDateEpoch\)/u);
  assert.match(windows, /-- Built on \$buildDate/u);
  const producer = sliceBetween(
    windows,
    "function Add-PostgisMesonProducer {",
    "function Add-PgcryptoMesonProducer {",
  );
  assertOrdered(
    producer,
    "$env:SOURCE_DATE_EPOCH =",
    "Initialize-WindowsPostgisGeneratedSource",
    "Windows PostGIS producer",
  );
  assertOrdered(
    producer,
    "$env:SOURCE_DATE_EPOCH =",
    "Build-WindowsPostgisSql",
    "Windows PostGIS SQL producer",
  );
  assert.match(producer, /finally \{/u);
});

test("pinned upstream timestamp sites are all controlled by SOURCE_DATE_EPOCH", () => {
  const checkout = path.join(ROOT, "target/oliphaunt-sources/checkouts/postgis");
  if (!existsSync(path.join(checkout, "configure.ac"))) return;
  const configure = readFileSync(path.join(checkout, "configure.ac"), "utf8");
  const upgrades = readFileSync(path.join(checkout, "extensions/upgrade-paths-rules.mk"), "utf8");
  const uninstall = readFileSync(path.join(checkout, "utils/create_uninstall.pl"), "utf8");
  const unpackaged = readFileSync(path.join(checkout, "utils/create_unpackaged.pl"), "utf8");
  assert.match(configure, /SOURCE_DATE_EPOCH/u);
  assert.match(upgrades, /SOURCE_DATE_EPOCH/u);
  assert.match(uninstall, /ENV\{SOURCE_DATE_EPOCH\}/u);
  assert.match(unpackaged, /ENV\{SOURCE_DATE_EPOCH\}/u);
});

test("xtask validates and fingerprints the source epoch", () => {
  const manifest = read("tools/xtask/src/asset_manifest.rs");
  const checks = read("tools/xtask/src/asset_checks.rs");
  const spine = read("tools/xtask/src/source_spine.rs");
  assert.match(manifest, /source_date_epoch: Option<u64>/u);
  assert.match(checks, /--format=%ct/u);
  assert.match(checks, /expected source_date_epoch/u);
  assert.match(spine, /253_402_300_799/u);
  assert.match(spine, /PostGIS source metadata must pin source_date_epoch/u);
});

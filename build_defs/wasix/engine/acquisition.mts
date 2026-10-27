import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ENGINE_DLL_PACKAGE,
  ENGINE_SOURCE_PACKAGES,
  engineDeliveryManifests,
  normalizeEngineManifest,
} from '../../../src/wasix/runtime/engine/package.mts';
import { renderCargoToml } from '../../../tools/packaging/cargo-manifest.mts';

type Manifest = Record<string, any>;
type UpstreamPackage = keyof typeof ENGINE_SOURCE_PACKAGES;
export type EngineSourcePins = Record<
  UpstreamPackage,
  { version: string; url: string; sha256: string; strip_prefix: string; patches: string[] }
>;

/** A complete file replacement, applied after the declared upstream code patches. */
function manifestPatch(before: string, after: string): string {
  const lines = (text: string) => text.replace(/\n$/u, '').split('\n');
  const changed = (text: string, prefix: string) =>
    `${lines(text)
      .map((line) => prefix + line)
      .join('\n')}\n${text.endsWith('\n') ? '' : '\\ No newline at end of file\n'}`;
  return `diff --git a/Cargo.toml b/Cargo.toml\n--- a/Cargo.toml\n+++ b/Cargo.toml\n@@ -1,${lines(before).length} +1,${lines(after).length} @@\n${changed(before, '-')}${changed(after, '+')}`;
}

function targets(manifest: Manifest): Record<string, string> {
  const library = manifest.lib?.path ?? 'src/lib.rs';
  const paths = [
    library,
    ...['bin', 'test', 'example', 'bench'].flatMap((kind) =>
      (manifest[kind] ?? []).map((target: Manifest) => {
        assert.equal(typeof target.path, 'string', `Explicit engine Cargo ${kind} path required`);
        return target.path;
      }),
    ),
    ...(typeof manifest.package.build === 'string' ? [manifest.package.build] : []),
  ];
  return Object.fromEntries(paths.map((file) => [file, file === library ? '' : 'fn main() {}\n']));
}

/**
 * Dependency acquisition only. Empty Rust targets let Cargo resolve conventional
 * metadata without constructing the DLL. Public crates use the package builder's
 * real sources, bindings and payloads; these placeholders never ship or compile.
 */
export function prepareEngineAcquisition(
  upstreamManifests: Record<UpstreamPackage, string>,
  version: string,
  pins: EngineSourcePins,
) {
  const originals = Object.keys(ENGINE_SOURCE_PACKAGES) as UpstreamPackage[];
  assert.deepEqual(Object.keys(upstreamManifests).sort(), [...originals].sort());
  assert.deepEqual(Object.keys(pins).sort(), [...originals].sort());
  const files: Record<string, string> = {};
  const patch: Record<string, { path: string; version: string }> = {};
  const sources: Record<
    string,
    { url: string; sha256: string; strip_prefix: string; patches: string[] }
  > = {};
  function stage(name: string, manifest: Manifest) {
    const directory = `engine/${name}`;
    patch[name] = { path: directory, version };
    files[`${directory}/Cargo.toml`] = renderCargoToml(manifest);
    for (const [file, content] of Object.entries(targets(manifest)))
      files[`${directory}/${file}`] = content;
    return directory;
  }
  for (const original of originals) {
    const source = upstreamManifests[original];
    const upstream = Bun.TOML.parse(source);
    assert.equal(upstream.package?.name, original, `Wrong engine source for ${original}`);
    assert.equal(upstream.package.version, pins[original].version, `Stale source pin ${original}`);
    const manifest = Bun.TOML.parse(
      normalizeEngineManifest(source, { version, facadeVersion: '0.0.0' }),
    );
    const name = ENGINE_SOURCE_PACKAGES[original];
    const directory = stage(name, manifest);
    const replacement = `${directory}/Cargo.toml.patch`;
    files[replacement] = manifestPatch(source, files[`${directory}/Cargo.toml`]);
    const pin = pins[original];
    sources[`${name} ${version}`] = {
      url: pin.url,
      sha256: pin.sha256,
      strip_prefix: pin.strip_prefix,
      patches: [...pin.patches.map((file) => `//src/wasix/runtime/engine:${file}`), replacement],
    };
  }
  const delivery = engineDeliveryManifests(version);
  const members = Object.entries(delivery).map(([name, manifest]) => {
    delete manifest.workspace;
    if (name === ENGINE_DLL_PACKAGE)
      for (const [dependency, requirement] of Object.entries(manifest.dependencies))
        if (Object.hasOwn(delivery, dependency))
          manifest.dependencies[dependency] = { path: `../${dependency}`, version: requirement };
    return stage(name, manifest);
  });
  return { files, members, patch, sources };
}

if (import.meta.main) {
  const [versionManifest, sourcesFile, outputFile] = process.argv.slice(2);
  if (!versionManifest || !sourcesFile || !outputFile)
    throw new Error('Expected SDK manifest, acquired source pins and output file');
  const pins = JSON.parse(readFileSync(sourcesFile, 'utf8')).crates as EngineSourcePins;
  const manifests = Object.fromEntries(
    Object.keys(pins).map((name) => [
      name,
      readFileSync(path.join(path.dirname(sourcesFile), 'upstream', name, 'Cargo.toml'), 'utf8'),
    ]),
  ) as Record<UpstreamPackage, string>;
  writeFileSync(
    outputFile,
    JSON.stringify(
      prepareEngineAcquisition(
        manifests,
        Bun.TOML.parse(readFileSync(versionManifest, 'utf8')).package.version,
        pins,
      ),
    ),
  );
}

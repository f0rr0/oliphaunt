import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertExtensionArtifactClosure,
  validateExtensionArtifactEntries,
} from '../../packages/tools/extension-artifact-inventory.mts';
import { writeArtifactDirectory } from './extension-artifact-packager.mts';

const repo = path.resolve(import.meta.dir, '../../../../..');
const recipe = Bun.TOML.parse(
  await fs.readFile(path.join(repo, 'src/extensions/external/postgis/recipe.toml'), 'utf8'),
);
const source = Bun.TOML.parse(
  await fs.readFile(path.join(repo, 'src/extensions/external/postgis/source.toml'), 'utf8'),
);
const version = source['extension-control']['default-version'];
const controls = ['postgis', 'postgis_raster', 'postgis_topology', 'postgis_tiger_geocoder'];
const stems = ['postgis-3', 'postgis_raster-3', 'postgis_topology-3'];

async function write(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
}

async function entriesAt(root) {
  const entries = new Map();
  for (const relative of await fs.readdir(root, { recursive: true })) {
    const file = path.join(root, relative);
    const stat = await fs.stat(file);
    if (!stat.isFile()) continue;
    const data = await fs.readFile(file);
    entries.set(relative.split(path.sep).join('/'), {
      data,
      bytes: data.length,
      mode: stat.mode & 0o777,
      sha256: createHash('sha256').update(data).digest('hex'),
    });
  }
  return entries;
}

for (const [target, suffix] of [
  ['linux-x64-gnu', '.so'],
  ['macos-arm64', '.dylib'],
  ['windows-x64-msvc', '.dll'],
  ['android-arm64-v8a', '.so'],
  ['android-x86_64', '.so'],
  ['ios-xcframework', '.dylib'],
]) {
  test(`PostGIS ${target} freezes and stages its declared companion closure`, async () => {
    const mobile = target === 'ios-xcframework' || target.startsWith('android-');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'postgis-artifact-'));
    const runtime = path.join(root, 'runtime');
    const embedded = path.join(root, 'embedded');
    const artifact = path.join(root, 'artifact');
    const dataFiles = recipe.artifacts.data_files.map((file) =>
      file.slice('share/postgresql/'.length),
    );
    const metadata = {
      sqlName: 'postgis',
      createsExtension: true,
      nativeModuleStem: 'postgis-3',
      sqlMembers: [...controls].sort(),
      nativeModuleStems: [...stems].sort(),
      dependencies: [],
      dataFiles,
      extensionSqlFileNames: recipe.artifacts.extension_sql_file_names,
      extensionSqlFilePrefixes: recipe.artifacts.extension_sql_file_prefixes,
      sharedPreloadLibraries: [],
    };
    const args = {
      ...metadata,
      runtime,
      embeddedModuleRoot: embedded,
      nativeTarget: target,
      nativeModuleFile: `postgis-3${suffix}`,
      nativeRuntimeProduct: 'liboliphaunt-native',
      nativeRuntimeVersion: '1.2.3',
      mobileStaticArchives: [],
      mobileStaticDependencyArchives: [],
      staticSymbolAliases: [],
      mobilePrebuilt: false,
    };
    try {
      for (const name of controls) {
        const module = stems.find((stem) => stem === `${name}-3`);
        await write(
          path.join(runtime, `share/postgresql/extension/${name}.control`),
          `default_version = '${version}'\n` +
            (module ? `module_pathname = '$libdir/${module}'\n` : ''),
        );
        await write(
          path.join(runtime, `share/postgresql/extension/${name}--${version}.sql`),
          module
            ? `CREATE FUNCTION ${name}_fixture() RETURNS text AS '$libdir/${module}', '${name}_fixture' LANGUAGE C;\n`
            : `-- ${name} install\n`,
        );
      }
      for (const stem of stems) {
        await write(path.join(runtime, `lib/postgresql/${stem}${suffix}`), `server ${stem}`);
        await write(path.join(embedded, `${stem}${suffix}`), `embedded ${stem}`);
      }
      await write(
        path.join(runtime, 'share/postgresql/extension/postgis_topology-foreign.control'),
        'foreign',
      );
      await write(
        path.join(runtime, `lib/postgresql/liboliphaunt_postgis_deps${suffix}`),
        'WASIX-only dependency',
      );
      for (const file of dataFiles) await write(path.join(runtime, 'share/postgresql', file), file);
      await writeArtifactDirectory(artifact, args);
      const entries = await entriesAt(artifact);
      const manifest = entries.get('manifest.properties').data.toString();
      assert(manifest.includes(`sqlMembers=${[...controls].sort().join(',')}\n`));
      for (const name of controls) {
        const module = stems.find((stem) => stem === `${name}-3`);
        for (const suffix of ['.control', `--${version}.sql`]) {
          const relative = `share/postgresql/extension/${name}${suffix}`;
          const original = await fs.readFile(path.join(runtime, relative), 'utf8');
          assert.equal(
            entries.get(`files/${relative}`).data.toString(),
            mobile && module
              ? original.replaceAll(`'$libdir/${module}'`, "'$libdir/postgis-3'")
              : original,
          );
          if (module) assert(original.includes(`'$libdir/${module}'`));
        }
      }
      if (mobile) {
        assert(manifest.includes('nativeModuleStems=postgis-3\n'));
        assertExtensionArtifactClosure(
          { ...metadata, nativeModuleStems: ['postgis-3'] },
          target,
          target,
        );
        assert.throws(
          () => assertExtensionArtifactClosure(metadata, target, target),
          /source-owned closure/,
        );
        for (const name of controls)
          assert(entries.has(`files/share/postgresql/extension/${name}.control`));
        assert(entries.has(`files/lib/postgresql/postgis-3${suffix}`));
        assert(!entries.has(`files/lib/postgresql/postgis_topology-3${suffix}`));
        assert(!entries.has(`files/lib/modules/postgis-3${suffix}`));
        return;
      }
      const validate = (selected) =>
        validateExtensionArtifactEntries({
          entries: selected,
          metadata,
          target,
          nativeRuntimeVersion: '1.2.3',
          label: target,
        });
      validate(entries);
      assert(!entries.has('files/share/postgresql/extension/postgis_topology-foreign.control'));
      assert(!entries.has(`files/lib/postgresql/liboliphaunt_postgis_deps${suffix}`));
      for (const stem of stems) {
        assert.equal(
          entries.get(`files/lib/postgresql/${stem}${suffix}`).data.toString(),
          `server ${stem}`,
        );
        assert.equal(
          entries.get(`files/lib/modules/${stem}${suffix}`).data.toString(),
          `embedded ${stem}`,
        );
      }
      for (const missing of [
        'files/share/postgresql/extension/postgis_topology.control',
        `files/share/postgresql/extension/postgis_tiger_geocoder--${version}.sql`,
        `files/lib/postgresql/postgis_raster-3${suffix}`,
        `files/lib/modules/postgis_topology-3${suffix}`,
      ]) {
        const incomplete = new Map(entries);
        incomplete.delete(missing);
        assert.throws(() => validate(incomplete), /missing|canonical installation script/);
      }
      await fs.unlink(path.join(embedded, `postgis_topology-3${suffix}`));
      await assert.rejects(writeArtifactDirectory(path.join(root, 'incomplete'), args), /ENOENT/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

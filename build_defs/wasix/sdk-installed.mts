import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractNpmPackage } from './browser/npm-archives.mts';

type Package = { name: string; version: string; archive: string };
type Inputs = { packages: Package[] };

export async function stageWasixSdkPackages(
  root: string,
  {
    sdk,
    runtime,
    addon,
    extension,
    packages,
  }: {
    sdk: string;
    runtime: string;
    addon: string;
    extension: string;
    packages: Package[];
  },
) {
  const modules = path.join(root, 'node_modules');
  const manifests = new Map<string, any>();
  const stage = async (archive: string, expected?: Package) => {
    const directory = path.join(root, `package-${manifests.size}`);
    await extractNpmPackage(archive, directory);
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    assert.match(manifest.name, /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u);
    assert(Bun.semver.satisfies(manifest.version, manifest.version), 'invalid packed version');
    if (expected) {
      assert.equal(manifest.name, expected.name, 'installed SDK package identity differs');
      assert.equal(manifest.version, expected.version, 'installed SDK package version differs');
    }
    assert(!manifests.has(manifest.name), 'duplicate installed SDK package');
    const destination = path.join(modules, manifest.name);
    await mkdir(path.dirname(destination), { recursive: true });
    // Keep actual package bytes intact; this is an ordinary private install tree.
    await rename(directory, destination);
    manifests.set(manifest.name, manifest);
    return manifest;
  };
  const candidate = await stage(sdk);
  const core = await stage(runtime);
  const native = await stage(addon);
  const member = await stage(extension);
  for (const pkg of packages) await stage(pkg.archive, pkg);
  assert.equal(candidate.name, '@oliphaunt/wasix-ts');
  assert.equal(core.name, '@oliphaunt/liboliphaunt-wasix');
  assert.equal(native.name, '@oliphaunt/wasix-napi-linux-x64-gnu');
  assert.equal(member.name, '@oliphaunt/extension-pgtap-wasix');
  assert.equal(candidate.oliphaunt.runtimeProduct, 'liboliphaunt-wasix');
  assert.equal(core.version, candidate.oliphaunt.runtimeVersion, 'SDK runtime pin differs');
  assert.equal(native.version, candidate.oliphaunt.wasixNapiVersion, 'SDK addon pin differs');
  assert.equal(candidate.optionalDependencies[native.name], native.version);
  assert.equal(native.oliphaunt.runtimeVersion, core.version, 'addon runtime pin differs');
  assert.equal(member.oliphaunt.wasixRuntimeVersion, core.version, 'pgTAP runtime pin differs');
  assert.deepEqual(native.os, ['linux']);
  assert.deepEqual(native.cpu, ['x64']);
  assert.deepEqual(native.libc, ['glibc']);
  for (const manifest of manifests.values())
    for (const [name, requirement] of Object.entries(manifest.dependencies ?? {})) {
      const dependency = manifests.get(name);
      assert(dependency, `installed SDK omits declared dependency ${name}`);
      assert(
        typeof requirement === 'string' && Bun.semver.satisfies(dependency.version, requirement),
        `installed SDK dependency ${name}@${dependency.version} does not satisfy ${requirement}`,
      );
    }
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: Object.fromEntries(
        [...manifests].map(([name, manifest]) => [name, manifest.version]),
      ),
    }),
  );
  return { candidate: candidate.name, extension: member.name };
}

export async function runWasixSdkHostContracts({
  sdk,
  runtime,
  addon,
  extension,
  fixture,
  pgwire,
  node,
  deno,
  electron,
  specification,
  runfiles,
}: {
  sdk: string;
  runtime: string;
  addon: string;
  extension: string;
  fixture: string;
  pgwire: string;
  node: string;
  deno: string;
  electron: string;
  specification: string;
  runfiles: string;
}) {
  const inputs: Inputs = JSON.parse(await readFile(specification, 'utf8'));
  const root = await mkdtemp(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'wasix-sdk-hosts-'));
  try {
    const installed = await stageWasixSdkPackages(root, {
      sdk,
      runtime,
      addon,
      extension,
      packages: inputs.packages.map((pkg) => ({
        ...pkg,
        archive: path.join(runfiles, pkg.archive),
      })),
    });
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    const assertions = transpiler.transformSync(await readFile(fixture, 'utf8'));
    const wire = path.join(root, 'pgwire-client.mjs');
    await writeFile(wire, transpiler.transformSync(await readFile(pgwire, 'utf8')));
    const env = {
      ...process.env,
      NODE_OPTIONS: '',
      NODE_PATH: '',
      ELECTRON_RUN_AS_NODE: '1',
      DENO_NO_UPDATE_CHECK: '1',
      DENO_DIR: path.join(root, 'deno-cache'),
    };
    for (const key of Object.keys(env))
      if (
        key !== 'OLIPHAUNT_WASM_AOT_VERIFY' &&
        /^(?:BUN_|RUNFILES|TEST_SRCDIR|OLIPHAUNT_|LIBOLIPHAUNT_|LD_|DYLD_)/u.test(key)
      )
        delete env[key];
    for (const host of ['node', 'bun', 'deno', 'electron'] as const) {
      const directory = path.join(root, host);
      await mkdir(directory);
      const entry = path.join(directory, 'verify.mjs');
      await writeFile(entry, assertions);
      const condition = host === 'electron' ? 'node' : host;
      await writeFile(
        path.join(directory, 'fixture.json'),
        JSON.stringify({
          ...installed,
          runtime: host,
          runtimeName:
            host === 'electron'
              ? 'Electron'
              : host === 'deno'
                ? 'Deno'
                : host === 'bun'
                  ? 'Bun'
                  : 'Node',
          storageCondition: condition,
          packageOnly: false,
          expectedEntrypoint: `index.${condition}.js`,
          expectedDirectEntrypoint: 'direct.node.js',
          expectedWorkerEntrypoint: `worker-entry.${condition}.js`,
          expectedServerEntrypoint: 'server.node.js',
          pgwireClientUrl: pathToFileURL(wire).href,
        }),
      );
      const command =
        host === 'node'
          ? [node, entry]
          : host === 'bun'
            ? [process.execPath, '--no-install', '--no-env-file', entry]
            : host === 'deno'
              ? [deno, 'run', '--no-config', '--node-modules-dir=manual', '--allow-all', entry]
              : [electron, entry];
      const child = Bun.spawn(command, {
        cwd: directory,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 180_000,
        killSignal: 'SIGKILL',
      });
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      assert.equal(status, 0, `${host} original public SDK contract failed\n${stdout}\n${stderr}`);
      console.log(
        `${host} original public SDK actor/direct/worker/server contract passed\n${stdout}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [sdk, runtime, addon, extension, fixture, pgwire, node, deno, electron, specification] =
    process.argv.slice(2);
  const runfiles = process.env.OLIPHAUNT_BAZEL_RUNFILES;
  assert(
    sdk &&
      runtime &&
      addon &&
      extension &&
      fixture &&
      pgwire &&
      node &&
      deno &&
      electron &&
      specification &&
      runfiles,
    'WASIX SDK contracts require the complete declared package/tool/fixture inputs',
  );
  await runWasixSdkHostContracts({
    sdk,
    runtime,
    addon,
    extension,
    fixture,
    pgwire,
    node,
    deno,
    electron,
    specification,
    runfiles,
  });
}

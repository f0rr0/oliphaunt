/** Acquisition-only projection of the existing Wasmer LLVM host pins. */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DESKTOP_TARGETS } from '../../tools/release/release-artifact-targets.mts';

interface HostPin {
  triple: string;
  wasixLlvmUrl?: string;
  wasixLlvmSha256?: string;
  wasixLlvmBytes?: number;
}

export function llvmPins(hosts: Record<string, HostPin>, llvmSysVersion: string) {
  const encoded = Number(llvmSysVersion.split('.')[0]);
  if (!Number.isSafeInteger(encoded) || encoded < 100) throw new Error('invalid llvm-sys version');
  const version = `${Math.floor(encoded / 10)}.${encoded % 10}`;
  const pins: Record<string, { triple: string; url: string; sha256: string; bytes: number }> = {};
  const unavailable: string[] = [];
  for (const [host, facts] of Object.entries(hosts).sort(([a], [b]) => a.localeCompare(b))) {
    if (facts.wasixLlvmUrl === undefined) {
      if (facts.wasixLlvmSha256 !== undefined || facts.wasixLlvmBytes !== undefined) {
        throw new Error(`incomplete LLVM pin: ${host}`);
      }
      unavailable.push(host);
      continue;
    }
    if (
      !facts.wasixLlvmUrl.startsWith(
        'https://github.com/wasmerio/llvm-custom-builds/releases/download/',
      ) ||
      !/^[0-9a-f]{64}$/u.test(facts.wasixLlvmSha256 ?? '') ||
      !Number.isSafeInteger(facts.wasixLlvmBytes) ||
      (facts.wasixLlvmBytes ?? 0) <= 0 ||
      (facts.wasixLlvmBytes ?? 0) > 2_147_483_648
    )
      throw new Error(`invalid LLVM pin: ${host}`);
    pins[host] = {
      triple: facts.triple,
      url: facts.wasixLlvmUrl,
      sha256: facts.wasixLlvmSha256 as string,
      bytes: facts.wasixLlvmBytes as number,
    };
  }
  return { version, llvm_sys_abi: encoded, hosts: pins, unavailable };
}

interface CargoPackage {
  name: string;
  version: string;
  dependencies?: string[];
}

export function llvmSysVersion(packages: CargoPackage[], wasmerVersion: string): string {
  const compiler = packages.find(
    (entry) => entry.name === 'wasmer-compiler-llvm' && entry.version === wasmerVersion,
  );
  if (!compiler) throw new Error('locked Wasmer compiler is missing');
  const pending = [compiler];
  const visited = new Set<CargoPackage>();
  const versions = new Set<string>();
  for (let index = 0; index < pending.length; index += 1) {
    const entry = pending[index];
    if (visited.has(entry)) continue;
    visited.add(entry);
    if (entry.name === 'llvm-sys') versions.add(entry.version);
    for (const dependency of entry.dependencies ?? []) {
      const [name, version] = dependency.split(' ');
      const candidates = packages.filter(
        (item) => item.name === name && (version === undefined || item.version === version),
      );
      if (candidates.length !== 1) throw new Error(`ambiguous locked dependency: ${dependency}`);
      pending.push(candidates[0]);
    }
  }
  if (versions.size !== 1) throw new Error('locked Wasmer compiler requires one LLVM ABI');
  return [...versions][0];
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { root: { type: 'string' }, 'output-dir': { type: 'string' } },
  });
  if (!values.root || !values['output-dir'])
    throw new Error('--root and --output-dir are required');
  const root = path.resolve(values.root);
  const observed: Record<string, string> = {};
  const read = (file: string): string => {
    const absolute = path.resolve(root, file);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (relative.startsWith('../') || path.isAbsolute(relative))
      throw new Error('metadata input escapes workspace');
    const source = readFileSync(absolute, 'utf8');
    observed[relative] = source;
    return source;
  };
  const pending = [path.resolve(import.meta.filename)];
  const visited = new Set<string>();
  const scanner = new Bun.Transpiler({ loader: 'ts' });
  for (let index = 0; index < pending.length; index += 1) {
    const module = pending[index];
    if (visited.has(module)) continue;
    visited.add(module);
    for (const entry of scanner.scanImports(read(module).replace(/^#![^\r\n]*/u, ''))) {
      if (entry.path.startsWith('node:') || entry.path === 'bun') continue;
      if (!entry.path.startsWith('.'))
        throw new Error(`undeclared metadata dependency: ${entry.path}`);
      let dependency = path.resolve(path.dirname(module), entry.path);
      if (!existsSync(dependency)) {
        const authored = dependency.replace(/\.js$/u, '.ts');
        if (existsSync(authored)) dependency = authored;
      }
      if (!existsSync(dependency) || !statSync(dependency).isFile())
        throw new Error(`missing metadata dependency: ${dependency}`);
      pending.push(dependency);
    }
  }
  const toolchain = Bun.TOML.parse(read('src/wasix/runtime/toolchain.toml')) as {
    toolchain: { wasmer: string };
  };
  const lock = Bun.TOML.parse(read('Cargo.lock')) as { package: CargoPackage[] };
  const projection = llvmPins(
    DESKTOP_TARGETS,
    llvmSysVersion(lock.package, toolchain.toolchain.wasmer),
  );
  writeFileSync(
    path.join(values['output-dir'], 'llvm.json'),
    `${JSON.stringify(projection, null, 2)}\n`,
  );
  writeFileSync(
    path.join(values['output-dir'], 'targets.bzl'),
    `# Derived from the canonical DESKTOP_TARGETS reader.\nWASIX_AOT_TARGETS = ${JSON.stringify(
      Object.fromEntries(Object.entries(projection.hosts).map(([id, pin]) => [id, pin.triple])),
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(values['output-dir'], '.metadata-inputs.json'),
    `${JSON.stringify(observed)}\n`,
  );
}

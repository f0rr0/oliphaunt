import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { aggregate } from '../../../src/wasix/postmaster/lib/linear-memory-profile.mts';
import {
  AGGREGATE_RELATIVE,
  safeRelative,
} from '../../../src/wasix/postmaster/lib/receipt-files.mts';
import {
  linearMemorySourceHashes,
  receiptRelative,
  validateExportChain,
} from '../../../src/wasix/postmaster/lib/sealed-export-chain.mts';
import {
  checkInventory,
  receipt,
  structure,
  verifyReceipt,
  watInventory,
} from '../../../src/wasix/postmaster/wasmer/bin/verify-postmaster-concurrency-contract.mts';
import { verify } from '../../../src/wasix/postmaster/wasmer/bin/verify-postmaster-wasm-import.mts';
import { parseStrictJson } from '../../../tools/packaging/strict-json.mts';
import { writeAotModuleOutputs } from './guest-inputs.mts';

const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
type Side = { path: string; input: string; aliases: string[] };

export function modulePlan(manifest: string, inputs: string[]): Side[] {
  assert.equal(
    manifest.split('\n')[0],
    '# schema=oliphaunt.wasix-postmaster.sealed-side-modules.v1',
  );
  const byName = new Map<string, string>();
  for (const input of inputs) {
    assert(!byName.has(basename(input)), `duplicate side input basename: ${input}`);
    byName.set(basename(input), input);
  }
  const paths = new Set<string>();
  const plan = manifest
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const columns = line.split('\t');
      assert.equal(columns.length, 3, 'side module row must have three columns');
      const [path, aliasText, policy] = columns;
      const aliases = aliasText === '-' ? [] : aliasText.split(',');
      assert(policy, 'side module ABI policy is empty');
      for (const name of [path, ...aliases]) {
        safeRelative(name);
        assert(!paths.has(name), `duplicate side path: ${name}`);
        paths.add(name);
      }
      const input = byName.get(basename(path));
      assert(input, `missing declared side module: ${path}`);
      byName.delete(basename(path));
      return { path, input, aliases };
    });
  assert.equal(plan.length, 27, 'canonical side closure must contain 27 modules');
  assert.equal(byName.size, 0, 'declared side module is absent from canonical policy');
  return plan;
}

function put(path: string, bytes: Uint8Array | string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o644 });
}

function command(tool: string, args: string[], cwd: string) {
  const result = Bun.spawnSync([tool, ...args], {
    cwd,
    env: { LC_ALL: 'C', BINARYEN_CORES: '2' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  assert.equal(result.exitCode, 0, `${basename(tool)} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trimEnd();
}

async function concurrency(module: string, wasmDis: string, work: string, destination: string) {
  const wat = join(work, 'postgres.wat');
  const child = Bun.spawn([wasmDis, module], {
    env: { LC_ALL: 'C', BINARYEN_CORES: '2' },
    stdout: Bun.file(wat),
    stderr: 'pipe',
  });
  const stderr = new Response(child.stderr).text();
  assert.equal(await child.exited, 0, `wasm-dis failed: ${await stderr}`);
  const input = createReadStream(wat);
  const stream = Readable.toWeb(input)
    .pipeThrough(new TextDecoderStream('utf8', { fatal: true }))
    .pipeThrough(
      new TransformStream<string, string>({
        transform(chunk, controller) {
          assert(!chunk.includes('\r'), 'wasm-dis emitted non-canonical CR text');
          controller.enqueue(chunk);
        },
      }),
    );
  const lines = createInterface({ input: Readable.fromWeb(stream), crlfDelay: Infinity });
  try {
    const inventory = await watInventory(lines);
    structure(readFileSync(module));
    checkInventory(inventory);
    const contents = receipt(
      readFileSync(module),
      inventory,
      hash(readFileSync(wasmDis)),
      command(wasmDis, ['--version'], work),
    );
    verifyReceipt(contents, readFileSync(module));
    put(destination, contents);
  } finally {
    lines.close();
    input.destroy();
    rmSync(wat, { force: true });
  }
}

export async function sealModules(specPath: string, outputPath: string) {
  const spec = parseStrictJson(readFileSync(specPath, 'utf8'));
  const output = resolve(outputPath);
  const work = mkdtempSync(join(tmpdir(), 'postmaster-sealing-'));
  const seed = join(work, 'seed'),
    project = join(work, 'project');
  const tools = Object.fromEntries(
    Object.entries(spec.tools).map(([key, file]) => [key, resolve(file as string)]),
  );
  const policies = Object.fromEntries(
    Object.entries(spec.policies).map(([key, file]) => [key, resolve(file as string)]),
  );
  try {
    for (const file of Object.values(policies))
      put(join(project, 'wasmer/policies', basename(file)), readFileSync(file));
    const sideManifest = readFileSync(policies.sides, 'utf8');
    const plan = modulePlan(
      sideManifest,
      spec.sides.map((file: string) => resolve(file)),
    );
    put(join(seed, 'bin/postgres'), readFileSync(spec.main));
    put(join(seed, 'bin/initdb'), readFileSync(spec.initdb));
    for (const side of plan) put(join(seed, side.path), readFileSync(side.input));
    const prefix = join(output, 'share/postgresql/wasix-postmaster.sealed-export.');
    mkdirSync(dirname(prefix), { recursive: true });
    const sides = plan.map((side) => side.path);
    await concurrency(
      join(seed, 'bin/postgres'),
      tools.wasmDis,
      work,
      `${prefix}concurrency.seed.receipt`,
    );
    command(
      tools.sealer,
      [
        'seal',
        'bin/postgres',
        policies.mandatory,
        policies.dlsym,
        `${prefix}seed-proof.json`,
        `${prefix}allowlist`,
        ...sides,
      ],
      seed,
    );
    const stripped = join(work, 'postgres.stripped'),
      final = join(work, 'postgres.exports-sealed');
    command(tools.sealer, ['rewrite', 'bin/postgres', `${prefix}allowlist`, stripped], seed);
    command(
      tools.wasmOpt,
      [
        stripped,
        '--remove-unused-module-elements',
        '--enable-bulk-memory',
        '--enable-threads',
        '--enable-mutable-globals',
        '--enable-exception-handling',
        '--enable-extended-const',
        '-o',
        final,
      ],
      seed,
    );
    command(
      tools.sealer,
      [
        'attest-final',
        'bin/postgres',
        final,
        policies.mandatory,
        policies.dlsym,
        `${prefix}allowlist`,
        `${prefix}seed-proof.json`,
        `${prefix}final-proof.json`,
        join(output, receiptRelative),
        hash(readFileSync(tools.wasmOpt)),
        command(tools.wasmOpt, ['--version'], work),
        hash(Buffer.from(sideManifest)),
        ...sides,
      ],
      seed,
    );
    verify(readFileSync(final));
    put(`${prefix}start-proof.intermediate.json`, `${command(tools.start, [final], seed)}\n`);
    await concurrency(final, tools.wasmDis, work, `${prefix}concurrency.intermediate.receipt`);
    const beforeMemory = new Map([
      ['bin/postgres', hash(readFileSync(final))],
      ...plan.map((side) => [side.path, hash(readFileSync(side.input))] as [string, string]),
    ]);
    validateExportChain(output, project, beforeMemory);
    const index: string[] = [];
    for (const relative of ['bin/postgres', 'bin/initdb', ...sides].sort()) {
      const source = relative === 'bin/postgres' ? final : join(seed, relative);
      const receiptPath = `receipts/${relative}.json`;
      mkdirSync(dirname(join(output, relative)), { recursive: true });
      mkdirSync(dirname(join(work, receiptPath)), { recursive: true });
      command(
        tools.memory,
        ['seal', '--output', join(output, relative), '--receipt', join(work, receiptPath), source],
        seed,
      );
      command(tools.memory, ['verify', join(output, relative)], seed);
      index.push(`${relative}\t${receiptPath}`);
    }
    for (const side of plan)
      for (const alias of side.aliases)
        put(join(output, alias), readFileSync(join(output, side.path)));
    put(join(work, 'modules.tsv'), `${index.join('\n')}\n`);
    const profile = parseStrictJson(command(tools.memory, ['--profile-json'], work));
    aggregate(
      work,
      join(work, 'modules.tsv'),
      receiptRelative,
      hash(readFileSync(join(output, receiptRelative))),
      join(output, AGGREGATE_RELATIVE),
      profile,
    );
    validateExportChain(output, project, linearMemorySourceHashes(output));
    verify(readFileSync(join(output, 'bin/postgres')));
    put(
      join(output, 'share/postgresql/wasix-postmaster.start-proof.json'),
      `${command(tools.start, [join(output, 'bin/postgres')], seed)}\n`,
    );
    await concurrency(
      join(output, 'bin/postgres'),
      tools.wasmDis,
      work,
      join(output, 'share/postgresql/wasix-postmaster.concurrency.receipt'),
    );
    writeAotModuleOutputs(output, ['bin/postgres', 'bin/initdb', ...sides], spec.moduleOutputs);
    console.log(
      `Sealed exact postmaster closure: ${index.length} modules, ${plan.length} side modules`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  assert.equal(process.argv.length, 4, 'usage: seal-modules.mts SPEC OUTPUT');
  await sealModules(process.argv[2], process.argv[3]);
}

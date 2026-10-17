import { expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runRustfmtCheck } from './rustfmt.mts';

const rustfmt =
  process.env.OLIPHAUNT_RUSTFMT ??
  (process.env.OLIPHAUNT_BAZEL_RUNFILES && process.env.OLIPHAUNT_RUSTFMT_RUNFILE
    ? path.join(process.env.OLIPHAUNT_BAZEL_RUNFILES, process.env.OLIPHAUNT_RUSTFMT_RUNFILE)
    : undefined);
if (!rustfmt) throw new Error('Rust formatter tests require the declared formatter');

function fixture(run: (root: string, file: (name: string, bytes: string) => string) => void) {
  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-rustfmt-'));
  const file = (name: string, bytes: string) => {
    const target = path.join(root, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o644 });
    return target;
  };
  try {
    run(root, file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the declared edition and formatter check readonly sources without altering bytes or modes', () => {
  fixture((_root, file) => {
    const config = file('rustfmt.toml', 'edition = "2024"\nmax_width = 100\n');
    const source = file('crate/src/lib.rs', 'pub async fn probe() {}\n');
    chmodSync(source, 0o444);
    expect(runRustfmtCheck(rustfmt, config, [source]).status).toBe(0);
    expect(readFileSync(source, 'utf8')).toBe('pub async fn probe() {}\n');
    expect(statSync(source).mode & 0o777).toBe(0o444);
  });
});

test('formatting faults retain the logical path when distinct crates share a source basename', () => {
  fixture((_root, file) => {
    const config = file('rustfmt.toml', 'edition = "2024"\n');
    const first = file('first/src/lib.rs', 'pub fn first() {}\n');
    const bytes = 'pub fn second(){let value=1;}\n';
    const second = file('second/src/lib.rs', bytes);
    chmodSync(second, 0o444);
    const result = runRustfmtCheck(rustfmt, config, [first, second]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(second);
    expect(readFileSync(second, 'utf8')).toBe(bytes);
    expect(statSync(second).mode & 0o777).toBe(0o444);
  });
});

test('the explicit config controls formatting rather than an adjacent source config', () => {
  fixture((_root, file) => {
    const selected = file('policy/rustfmt.toml', 'edition = "2024"\nmax_width = 100\n');
    const adjacent = file('crate/rustfmt.toml', 'edition = "2024"\nmax_width = 40\n');
    const source = file(
      'crate/src/lib.rs',
      'pub fn width(first: u32, second: u32, third: u32) -> u32 {\n    first + second + third\n}\n',
    );
    expect(runRustfmtCheck(rustfmt, selected, [source]).status).toBe(0);
    expect(runRustfmtCheck(rustfmt, adjacent, [source]).status).toBe(1);
  });
});

test('child modules enter the check only as explicit source files', () => {
  fixture((_root, file) => {
    const config = file('rustfmt.toml', 'edition = "2024"\n');
    const root = file('crate/src/lib.rs', 'mod child;\n');
    const child = file('crate/src/child.rs', 'pub fn child(){let value=1;}\n');
    expect(runRustfmtCheck(rustfmt, config, [root]).status).toBe(0);
    expect(runRustfmtCheck(rustfmt, config, [root, child]).status).toBe(1);
    expect(() => runRustfmtCheck(rustfmt, config, [])).toThrow('nonempty');
    expect(() => runRustfmtCheck(rustfmt, config, [root, root])).toThrow('unique');
  });
});

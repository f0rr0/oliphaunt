import { spawnSync } from 'node:child_process';

/** Each path retains its declared runfiles hierarchy; formatter traversal adds no sources. */
export function runRustfmtCheck(rustfmt: string, config: string, sources: string[]) {
  if (!rustfmt || !config || !sources.length || new Set(sources).size !== sources.length)
    throw new Error('Rust formatting requires one formatter, config and nonempty unique sources');
  const result = spawnSync(
    rustfmt,
    ['--check', '--config-path', config, '--config', 'skip_children=true', '--', ...sources],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status === null) throw new Error(`Rust formatter terminated by ${result.signal}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

if (import.meta.main) {
  try {
    const [rustfmt, config, ...sources] = process.argv.slice(2);
    const result = runRustfmtCheck(rustfmt, config, sources);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.status;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

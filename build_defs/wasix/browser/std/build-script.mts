import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export function buildScriptDirectives(stdout: string) {
  const flags: string[] = [];
  const env: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const directive = line.startsWith('cargo::')
      ? line.slice(7)
      : line.startsWith('cargo:')
        ? line.slice(6)
        : null;
    if (directive === null) continue;
    const separator = directive.indexOf('=');
    if (separator < 1) throw new Error(`Invalid standard-library build directive: ${line}`);
    const key = directive.slice(0, separator);
    const value = directive.slice(separator + 1);
    if (key === 'rustc-cfg' || key === 'rustc-check-cfg') flags.push(`--${key.slice(6)}`, value);
    else if (key === 'rustc-env') {
      const equal = value.indexOf('=');
      if (equal < 1 || value.includes('\r'))
        throw new Error(`Invalid standard-library environment directive: ${line}`);
      env[value.slice(0, equal)] = value.slice(equal + 1);
    } else if (key.startsWith('rustc-')) {
      throw new Error(`Undeclared standard-library compiler/linker directive: ${line}`);
    }
  }
  return { flags, env };
}

if (import.meta.main) {
  const [, , binary, directory, output, flagsPath, envPath, compiler] = process.argv;
  const cwd = resolve(directory);
  const out = resolve(output);
  const script = resolve(binary);
  const rustc = resolve(compiler);
  await mkdir(out, { recursive: true });
  const child = Bun.spawn([script], {
    cwd,
    env: { ...process.env, CARGO_MANIFEST_DIR: cwd, OUT_DIR: out, RUSTC: rustc },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (status !== 0) throw new Error(`Standard-library build script failed (${status}): ${stderr}`);
  const directives = buildScriptDirectives(stdout);
  await Bun.write(flagsPath, directives.flags.join('\n') + (directives.flags.length ? '\n' : ''));
  await Bun.write(
    envPath,
    Object.entries(directives.env)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + (Object.keys(directives.env).length ? '\n' : ''),
  );
}

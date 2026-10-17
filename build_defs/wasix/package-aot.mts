/** Stage four declared serializer outputs and their frozen runtime manifest. */
import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

export interface AotPayloadSpec {
  portable_manifest: string;
  toolchain: string;
  target_triple: string;
  artifacts: { name: string; path: string; image: string; module: string }[];
}

export async function packageAot(
  spec: AotPayloadSpec,
  specPath: string,
  output: string,
  manifestTool: string,
): Promise<void> {
  if (path.basename(output) !== spec.target_triple)
    throw new Error('AOT payload directory must match its declared target triple');
  const paths = new Set<string>();
  await mkdir(output, { recursive: true });
  for (const artifact of spec.artifacts) {
    if (!/^[a-z_]+-llvm-opta\.bin\.zst$/u.test(artifact.path) || paths.has(artifact.path))
      throw new Error(`unsafe or duplicate AOT artifact path: ${artifact.path}`);
    paths.add(artifact.path);
    const destination = path.join(output, artifact.path);
    await copyFile(artifact.image, destination);
    await chmod(destination, 0o644);
  }
  const result = Bun.spawnSync(
    [
      manifestTool,
      'assets',
      'declared-aot-manifest',
      '--spec',
      specPath,
      '--output',
      path.join(output, 'manifest.json'),
    ],
    { stdout: 'inherit', stderr: 'inherit', env: { ...process.env, LC_ALL: 'C' } },
  );
  if (result.exitCode !== 0)
    throw new Error(`AOT manifest tool failed with exit ${result.exitCode}`);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      spec: { type: 'string' },
      output: { type: 'string' },
      'manifest-tool': { type: 'string' },
    },
  });
  if (!values.spec || !values.output || !values['manifest-tool'])
    throw new Error('--spec, --output and --manifest-tool are required');
  const spec = JSON.parse(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(values.spec)),
  ) as AotPayloadSpec;
  await packageAot(spec, values.spec, values.output, values['manifest-tool']);
}

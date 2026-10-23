/** Stage the two declared frontend commands with their existing public manifest. */
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { stageReleaseNotices } from '../../tools/packaging/release-notices.mts';
import { type RuntimePayloadSpec, sourceFacts } from './package.mts';

export interface ToolsPayloadSpec
  extends Pick<RuntimePayloadSpec, 'postgresSource' | 'postgresSeries' | 'patches' | 'icuSource'> {
  pgDump: string;
  psql: string;
  version: string;
  runtimeVersion: string;
  notices: Record<string, string>;
}

export async function packageTools(
  spec: ToolsPayloadSpec,
  output: string,
  manifestTool: string,
): Promise<void> {
  output = path.resolve(output);
  await mkdir(path.join(output, 'bin'), { recursive: true });
  const manifestSpec = path.join(output, '.manifest-inputs.json');
  const noticeRoot = path.join(output, '.notice-source');
  try {
    const paths: Record<string, string> = {};
    for (const [name, source] of [
      ['pg_dump', spec.pgDump],
      ['psql', spec.psql],
    ]) {
      const file = path.join(output, `bin/${name}.wasix.wasm`);
      await copyFile(source, file);
      await chmod(file, 0o644);
      paths[name] = file;
    }
    await writeFile(
      manifestSpec,
      JSON.stringify({
        ...(await sourceFacts(spec)),
        ...paths,
        version: spec.version,
        runtime_version: spec.runtimeVersion,
      }),
    );
    const result = Bun.spawnSync(
      [
        manifestTool,
        'assets',
        'declared-tools-manifest',
        '--spec',
        manifestSpec,
        '--output',
        path.join(output, 'manifest.json'),
      ],
      { stdout: 'inherit', stderr: 'inherit', env: { ...process.env, LC_ALL: 'C' } },
    );
    if (result.exitCode !== 0)
      throw new Error(`tools manifest tool failed with exit ${result.exitCode}`);
    for (const [destination, source] of Object.entries(spec.notices)) {
      if (
        !destination ||
        path.isAbsolute(destination) ||
        destination.includes('\\') ||
        destination.split('/').some((part) => !part || part === '.' || part === '..')
      )
        throw new Error(`unsafe declared notice destination: ${destination}`);
      const file = path.join(noticeRoot, destination);
      await mkdir(path.dirname(file), { recursive: true });
      await copyFile(source, file);
    }
    stageReleaseNotices(output, { profile: 'wasix-tools', sourceRoot: noticeRoot });
  } finally {
    await rm(manifestSpec, { force: true });
    await rm(noticeRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      spec: { type: 'string' },
      output: { type: 'string' },
      'manifest-tool': { type: 'string' },
    },
    strict: true,
  });
  if (!values.spec || !values.output || !values['manifest-tool'])
    throw new Error('--spec, --output and --manifest-tool are required');
  await packageTools(
    JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        await readFile(values.spec),
      ),
    ),
    values.output,
    values['manifest-tool'],
  );
}

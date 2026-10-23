import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

export function generateUniffi({
  generator,
  library,
  configuration,
  language,
  directory,
}: {
  generator: string;
  library: string;
  configuration: string;
  language: 'swift' | 'kotlin';
  directory: string;
}) {
  // Unix metadata retains the fd-based mobile API; Windows metadata omits it.
  assert.ok(
    process.platform === 'darwin' || process.platform === 'linux',
    'Mobile binding metadata requires a Unix execution host',
  );
  const result = spawnSync(
    generator,
    [
      'generate',
      '--library',
      library,
      '--config',
      configuration,
      '--language',
      language,
      '--no-format',
      '--out-dir',
      directory,
    ],
    { stdio: 'inherit', env: {} },
  );
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, 'Declared UniFFI generator failed');
}

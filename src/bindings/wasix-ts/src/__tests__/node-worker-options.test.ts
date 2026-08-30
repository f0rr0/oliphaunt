import { describe, expect, it } from 'vitest';

import { nodeWorkerExecArgv } from '../node-worker-options.js';

describe('Node-compatible Worker exec arguments', () => {
  it('removes invocation modes and their operands from a file-backed Worker', () => {
    expect(
      nodeWorkerExecArgv([
        '--input-type=module',
        '--inspect=127.0.0.1:0',
        '--input-type',
        'commonjs',
        '--eval',
        'await import("./verify.mjs")',
        '-p',
        'process.version',
        '--interactive',
        '--test-reporter',
        'spec',
        '--watch-path',
        './src',
        '--run=dev',
      ]),
    ).toEqual(['--inspect=127.0.0.1:0']);
  });

  it('preserves compatible runtime flags and their operands', () => {
    const inherited = [
      '--enable-source-maps',
      '--loader',
      './runtime-loader.mjs',
      '--conditions=development',
    ];

    expect(nodeWorkerExecArgv(inherited)).toEqual(inherited);
  });
});

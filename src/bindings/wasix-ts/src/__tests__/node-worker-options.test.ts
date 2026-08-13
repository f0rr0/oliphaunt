import { describe, expect, it } from 'vitest';

import { nodeWorkerExecArgv } from '../node-worker-options.js';

describe('Node worker exec arguments', () => {
  it('removes both forms of the file-worker-incompatible input type flag', () => {
    expect(
      nodeWorkerExecArgv([
        '--input-type=module',
        '--inspect=127.0.0.1:0',
        '--input-type',
        'commonjs',
      ]),
    ).toEqual(['--inspect=127.0.0.1:0']);
  });

  it('preserves compatible inherited flags and their operands', () => {
    const inherited = ['--enable-source-maps', '--eval', 'await import("./verify.mjs")'];

    expect(nodeWorkerExecArgv(inherited)).toEqual(inherited);
  });
});

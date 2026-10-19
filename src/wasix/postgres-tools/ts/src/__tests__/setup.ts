import { mock } from 'bun:test';
import * as runtime from './wasix-ts-runtime.js';

mock.module('@oliphaunt/wasix-ts/internal/tools', () => runtime);
mock.module('@oliphaunt/liboliphaunt-wasix-tools', () => ({
  default: {
    schema: 'oliphaunt-wasix-tools-v1',
    product: 'oliphaunt-wasix-tools',
    runtimeProduct: 'liboliphaunt-wasix',
    runtimeVersion: '1.2.3',
    pgDump: { name: 'pg_dump' },
    psql: { name: 'psql' },
  },
}));

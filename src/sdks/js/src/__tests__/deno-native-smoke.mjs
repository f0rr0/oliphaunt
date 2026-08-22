import { Oliphaunt } from '../../lib/index.js';
import { assertNativeDatabaseContract } from './native-direct-contract.mjs';

const libraryPath = Deno.env.get('LIBOLIPHAUNT_PATH');
if (!libraryPath) {
  throw new Error('LIBOLIPHAUNT_PATH is required for the TypeScript SDK Deno smoke check');
}

await assertNativeDatabaseContract(Oliphaunt, { execution: 'direct', libraryPath }, 'deno-direct');

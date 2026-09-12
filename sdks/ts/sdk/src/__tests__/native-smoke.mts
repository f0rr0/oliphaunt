import { pathToFileURL } from 'node:url';
import { assertNativeDatabaseContract } from './native-direct-contract.mts';

const { Oliphaunt } = await import(
  process.env.OLIPHAUNT_SMOKE_SDK
    ? pathToFileURL(process.env.OLIPHAUNT_SMOKE_SDK).href
    : new URL('../../lib/index.js', import.meta.url).href
);

async function main(): Promise<void> {
  const libraryPath = requiredEnv('LIBOLIPHAUNT_PATH');
  await assertNativeDatabaseContract(
    Oliphaunt,
    { topology: 'direct', libraryPath },
    `${process.env.OLIPHAUNT_SMOKE_HOST}-direct`,
  );
  const brokerExecutable = process.env.OLIPHAUNT_BROKER;
  if (brokerExecutable) {
    await assertNativeDatabaseContract(
      Oliphaunt,
      { topology: 'broker', libraryPath, brokerExecutable },
      `${process.env.OLIPHAUNT_SMOKE_HOST}-broker`,
    );
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the TypeScript SDK native smoke check`);
  return value;
}

await main();

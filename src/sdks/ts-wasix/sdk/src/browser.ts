const host = globalThis as typeof globalThis & {
  process?: { versions?: { node?: string } };
  Bun?: unknown;
  Deno?: unknown;
};
if (host.process?.versions?.node || host.Bun !== undefined || host.Deno !== undefined) {
  throw new Error(
    '@oliphaunt/wasix-ts/browser requires a browser or browser worker; use @oliphaunt/wasix-ts on Node.js, Bun, or Deno',
  );
}
export { Oliphaunt, Oliphaunt as default } from './client.js';
export * from './browser-public.js';

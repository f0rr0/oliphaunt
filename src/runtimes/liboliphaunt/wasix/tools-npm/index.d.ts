export type WasixToolModule = Readonly<{
  name: 'pg_dump' | 'psql';
  sha256: string;
  size: number;
  source: string;
}>;

export type WasixToolsDescriptor = Readonly<{
  schema: 'oliphaunt-wasix-tools-v1';
  product: 'oliphaunt-wasix-tools';
  version: string;
  runtimeProduct: 'liboliphaunt-wasix';
  runtimeVersion: string;
  pgDump: WasixToolModule;
  psql: WasixToolModule;
}>;

declare const descriptor: WasixToolsDescriptor;
export default descriptor;

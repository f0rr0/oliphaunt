export type WasixOutput = Readonly<{
  ok: boolean;
  code: number;
}>;

export class Directory {
  constructor(files?: Record<string, Uint8Array>);
  createDir(path: string): Promise<void>;
  readDir(path: string): Promise<
    Readonly<{ type: 'dir' | 'file' | 'unknown'; name: string }>[]
  >;
  readFile(path: string): Promise<Uint8Array>;
}

export class Instance {
  readonly stdin: WritableStream<Uint8Array> | undefined;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  free(): void;
  wait(): Promise<WasixOutput>;
}

export type RunWasixOptions = Readonly<{
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  mount: Record<string, Directory>;
}>;

export function init(options?: Record<string, unknown>): Promise<unknown>;
export function runWasix(module: Uint8Array, options: RunWasixOptions): Promise<Instance>;

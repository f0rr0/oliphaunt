import { randomUUID } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import {
  publishNativeDescriptor,
  validateCompletePgdata,
  validateManagedRoot,
} from '../root-descriptor.js';

export async function initializeNativePgdata(options: {
  root: string;
  pgdata: string;
  runInitdb(pgdata: string): Promise<void>;
}): Promise<void> {
  if (await validateManagedRoot(options.root)) return;

  const staging = join(dirname(options.root), `.${basename(options.root)}.pgdata-${randomUUID()}`);
  try {
    await options.runInitdb(staging);
    await validateCompletePgdata(staging);
    await rename(staging, options.pgdata);
    await publishNativeDescriptor(options.root);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

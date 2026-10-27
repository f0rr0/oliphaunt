import { readFileSync, rmSync } from 'node:fs';
import { assembleRelinkKit } from '../../../src/wasix/runtime/engine/relink.mts';
import { archiveDirectory } from '../../../tools/packaging/archive-directory.mts';

const { output, ...inputs } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const staging = `${output}.contents`;
try {
  assembleRelinkKit({ ...inputs, outputDirectory: staging });
  await archiveDirectory(staging, output);
} finally {
  rmSync(staging, { recursive: true, force: true });
}

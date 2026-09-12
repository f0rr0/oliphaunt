import path from 'node:path';
import {
  currentProductVersionSync,
  ROOT,
} from '../../../tools/release/release-artifact-targets.mts';
import { stageWasixToolsNpmCarrier } from './wasix-tools-npm-carrier.mts';
const version = currentProductVersionSync('postgres-tools-wasix', 'build-npm.mts');
stageWasixToolsNpmCarrier({
  version,
  portableReleaseArchive: path.join(
    ROOT,
    `target/postgres-tools/wasix/release-assets/postgres-tools-wasix-${version}-portable.tar.gz`,
  ),
  packageDir: path.join(ROOT, 'target/postgres-tools/wasix/npm/portable'),
});

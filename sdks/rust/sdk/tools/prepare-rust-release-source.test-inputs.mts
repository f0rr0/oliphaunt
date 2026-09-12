import path from 'node:path';
import {
  prepareOliphauntBuildReleaseSource,
  prepareRustReleaseSource,
} from './prepare-rust-release-source.mts';

const root = process.env.OLIPHAUNT_RUST_RELEASE_SOURCE_TEST_ROOT;
if (!root) throw new Error('Run bash sdks/rust/sdk/tools/prepare-rust-release-source.test.sh');
prepareRustReleaseSource({ stageDir: path.join(root, 'sdk/source'), log: false });
prepareOliphauntBuildReleaseSource({ stageDir: path.join(root, 'build/source'), log: false });

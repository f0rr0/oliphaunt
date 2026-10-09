import type { PreparedWasixRuntime } from '../../resources/extensions.js';
import type { WasixDirectoryMount } from '../../resources/archive.js';
import { snapshotStorageDirectory, snapshotToMount } from '../../storage/storage-snapshot.js';
import type { DirectWasixHost } from './direct-client-common.js';
import { materializeWasixMounts } from './wasix-runtime.js';
import { releaseWasixToolMounts } from '../../resources/tool-runtime.js';

/** Run the runtime's initdb in an isolated WASIX process tree for a new root. */
export async function initializeWasixStorage(
  host: DirectWasixHost,
  runtime: PreparedWasixRuntime,
): Promise<WasixDirectoryMount> {
  if (host.runWasix === undefined) throw new Error('WASIX host does not provide initdb execution');
  const initdb = runtime.layout.mounts['/bin']?.files.initdb;
  if (initdb === undefined) throw new Error('WASIX runtime archive is missing bin/initdb');
  const { mounts, baseDirectory } = await materializeWasixMounts(host.Directory, runtime.layout, {
    files: {},
    directories: [],
  });
  let snapshot: WasixDirectoryMount;
  try {
    const instance = await host.runWasix(initdb, {
      program: '/bin/initdb',
      cwd: '/',
      stdin: '',
      mount: mounts,
      args: [
        '--allow-group-access',
        '--encoding',
        'UTF8',
        '--locale',
        'C.UTF-8',
        '--locale-provider',
        'libc',
        '--auth',
        'trust',
        '-D',
        '/base',
      ],
      env: {
        PGDATA: '/base',
        PGSYSCONFDIR: '/base',
        HOME: '/home/postgres',
        USER: 'postgres',
        LOGNAME: 'postgres',
        PGCLIENTENCODING: 'UTF8',
        PATH: '/bin',
        LC_CTYPE: 'C.UTF-8',
        TZ: 'UTC',
        PGTZ: 'UTC',
        PG_COLOR: 'never',
        ...(runtime.icuEnabled
          ? { ICU_DATA: '/share/icu', OLIPHAUNT_INTERNAL_ICU_READY: '1' }
          : { OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY: '1' }),
      },
    });
    // wait consumes the wasm-bindgen instance handle.
    const output = await instance.wait();
    if (!output.ok || output.code !== 0) {
      throw new Error(`WASIX initdb failed (${output.code}): ${output.stderr.trim()}`);
    }
    if ((await baseDirectory.readTextFile('PG_VERSION')).trim() !== '18') {
      throw new Error('WASIX initdb did not create a PostgreSQL 18 cluster');
    }
    snapshot = snapshotToMount(await snapshotStorageDirectory(baseDirectory));
  } catch (primary) {
    releaseWasixToolMounts(mounts, { primary });
  }
  releaseWasixToolMounts(mounts);
  return snapshot;
}

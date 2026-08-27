import { WasixDatabaseImpl } from './database.js';
import { DirectWasixSession, type DirectWasixHost } from './direct-client-common.js';
import * as host from './node-host.js';
import { installNodeEnvironment } from './node-environment.js';
import type { SerializedOpenOptions } from './rpc.js';
import type { OliphauntDatabase } from './types.js';

const directHost: DirectWasixHost = {
  Directory: host.Directory,
  init: host.init,
  instantiateOliphauntDirect: host.instantiateOliphauntDirect,
  prepareOliphauntTool: host.prepareOliphauntTool,
  runOliphauntToolDirect: host.runOliphauntToolDirect,
};

/** @internal Own one Node-realm WASIX session without an RPC boundary. */
export async function openNodeDirectSession(
  options: SerializedOpenOptions,
): Promise<DirectWasixSession> {
  installNodeEnvironment();
  return DirectWasixSession.open(options, directHost, undefined, 'node');
}

/** @internal Open the public database contract in the current Node realm. */
export async function openNodeDirect(options: SerializedOpenOptions): Promise<OliphauntDatabase> {
  return new WasixDatabaseImpl(await openNodeDirectSession(options));
}

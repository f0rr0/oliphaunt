import { WasixDatabaseImpl } from '../../core/database.js';
import { NativeWasixSession } from './native-session.js';
import type { SerializedOpenOptions } from '../../workers/rpc.js';
import type { OliphauntDatabase } from '../../core/types.js';

/** @internal Own one synchronous Rust WASIX session in the current JS realm. */
export async function openNodeDirectSession(
  options: SerializedOpenOptions,
): Promise<NativeWasixSession> {
  return NativeWasixSession.open(options);
}

/** @internal Open the public database contract in the current Node realm. */
export async function openNodeDirect(options: SerializedOpenOptions): Promise<OliphauntDatabase> {
  return new WasixDatabaseImpl(await openNodeDirectSession(options));
}

import { WasixDatabaseImpl } from './database.js';
import { NativeWasixActorSession } from './native-session.js';
import type { SerializedOpenOptions } from './rpc.js';
import type { OliphauntDatabase } from './types.js';

/** @internal Open one Rust-owner actor without blocking the importing event loop. */
export async function openNodeActorSession(
  options: SerializedOpenOptions,
): Promise<NativeWasixActorSession> {
  return NativeWasixActorSession.open(options);
}

/** @internal Open the public database contract over the native Rust owner. */
export async function openNodeActor(options: SerializedOpenOptions): Promise<OliphauntDatabase> {
  return new WasixDatabaseImpl(await openNodeActorSession(options));
}

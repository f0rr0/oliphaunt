export {
  type CommandResult,
  PostgresError,
  type PostgresErrorField,
  type QueryField,
  type QueryFormat,
  type QueryParam,
  type QueryResult,
  type QueryRow,
} from './query.js';
export type {
  BinaryInput,
  DatabaseStorage,
  OliphauntClient,
  OliphauntDatabase,
  OliphauntTransaction,
  OliphauntServer,
  OpenConfig,
  ServerListen,
  ServerOpenConfig,
} from './types.js';

import { createOliphauntClient } from './client.js';
import type { OliphauntClient } from './types.js';

export const Oliphaunt: OliphauntClient = createOliphauntClient();

export default Oliphaunt;

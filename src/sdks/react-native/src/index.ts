import NativeOliphaunt from './specs/NativeOliphaunt';
import { createOliphauntClient } from './client';

export type {
  BinaryInput,
  DatabaseStorage,
  RestoreDestination,
  OpenConfig,
  OliphauntDatabase,
  OliphauntClient,
  OliphauntTransaction,
} from './client';
export type {
  CommandResult,
  QueryField,
  QueryFormat,
  QueryParam,
  QueryResult,
  QueryRow,
  PostgresErrorField,
} from './query';
export { PostgresError } from './query';
export const Oliphaunt: import('./client').OliphauntClient = createOliphauntClient(NativeOliphaunt);

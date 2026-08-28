export {
  array,
  binary,
  json,
  postgresOids,
  text,
  typedNull,
  type BinaryQueryParameter,
  type CommandResult,
  type DescribeResult,
  type EncodedQueryParameter,
  type ExecResult,
  type InferQueryRow,
  type NullQueryParameter,
  type ParameterOptions,
  PostgresError,
  type PostgresErrorField,
  type PostgresNotice,
  type QueryArrayRow,
  type QueryBinaryInput,
  type QueryDecoderMap,
  type QueryField,
  type QueryFormat,
  type QueryObjectRow,
  type QueryOptions,
  type QueryParam,
  type QueryParameterEncoder,
  type QueryResult,
  type QueryRowMode,
  type QueryValue,
  type QueryValueDecoder,
  type RawQueryResult,
  type RawQueryRow,
  type TextQueryParameter,
  type TransactionStatus,
} from './query.js';
export type {
  BinaryInput,
  DatabaseStorage,
  OliphauntClient,
  OliphauntDatabase,
  OliphauntTransaction,
  OliphauntServer,
  OpenConfig,
  RestoreOptions,
  ServerListen,
  ServerOpenConfig,
} from './types.js';

import { createOliphauntClient } from './client.js';
import type { OliphauntClient } from './types.js';

export const Oliphaunt: OliphauntClient = createOliphauntClient();

export default Oliphaunt;

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
  ProtocolChunkCallback,
} from './client';
export type {
  BinaryQueryParameter,
  CommandResult,
  DescribeResult,
  EncodedQueryParameter,
  ExecResult,
  NullQueryParameter,
  ParameterOptions,
  PostgresErrorField,
  PostgresNotice,
  QueryArrayRow,
  QueryBinaryInput,
  QueryField,
  QueryFormat,
  QueryObjectRow,
  QueryOptions,
  QueryParam,
  QueryParameterEncoder,
  QueryResult,
  QueryValue,
  QueryValueDecoder,
  RawQueryResult,
  RawQueryRow,
  TextQueryParameter,
  TransactionStatus,
} from './query';
export {
  PostgresError,
  array,
  binary,
  json,
  postgresOids,
  text,
  typedNull,
} from './query';
export const Oliphaunt: import('./client').OliphauntClient = createOliphauntClient(NativeOliphaunt);

export default Oliphaunt;

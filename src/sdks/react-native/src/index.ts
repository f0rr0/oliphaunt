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
  BinaryQueryParameter,
  CommandResult,
  DescribeResult,
  EncodedQueryParameter,
  ExecResult,
  InferQueryRow,
  NullQueryParameter,
  ParameterOptions,
  PostgresErrorField,
  PostgresNotice,
  QueryArrayRow,
  QueryBinaryInput,
  QueryDecoderMap,
  QueryField,
  QueryFormat,
  QueryObjectRow,
  QueryOptions,
  QueryParam,
  QueryParameterEncoder,
  QueryResult,
  QueryRowMode,
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

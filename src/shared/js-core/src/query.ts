import { simpleQuery } from './protocol.js';

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export type QueryBinaryInput = ArrayBuffer | ArrayBufferView | Uint8Array;
export type ByteInput = QueryBinaryInput | ReadonlyArray<number>;

/** Stable PostgreSQL OIDs used by the built-in JavaScript codecs. */
export const postgresOids = Object.freeze({
  bool: 16,
  bytea: 17,
  char: 18,
  name: 19,
  int8: 20,
  int2: 21,
  int4: 23,
  text: 25,
  oid: 26,
  json: 114,
  xml: 142,
  float4: 700,
  float8: 701,
  unknown: 705,
  bpchar: 1042,
  varchar: 1043,
  date: 1082,
  time: 1083,
  timestamp: 1114,
  timestamptz: 1184,
  interval: 1186,
  timetz: 1266,
  numeric: 1700,
  uuid: 2950,
  jsonb: 3802,
  boolArray: 1000,
  byteaArray: 1001,
  charArray: 1002,
  nameArray: 1003,
  int2Array: 1005,
  int4Array: 1007,
  textArray: 1009,
  bpcharArray: 1014,
  varcharArray: 1015,
  int8Array: 1016,
  float4Array: 1021,
  float8Array: 1022,
  oidArray: 1028,
  dateArray: 1182,
  timeArray: 1183,
  timestampArray: 1115,
  timestamptzArray: 1185,
  intervalArray: 1187,
  numericArray: 1231,
  timetzArray: 1270,
  jsonArray: 199,
  xmlArray: 143,
  uuidArray: 2951,
  jsonbArray: 3807,
} as const);

declare const encodedQueryParameterBrand: unique symbol;

type EncodedQueryParameterBrand = {
  readonly [encodedQueryParameterBrand]: true;
};

export type TextQueryParameter = Readonly<
  EncodedQueryParameterBrand & {
    format: 'text';
    value: string;
    typeOid?: number;
  }
>;

export type BinaryQueryParameter = Readonly<
  EncodedQueryParameterBrand & {
    format: 'binary';
    value: QueryBinaryInput;
    typeOid?: number;
  }
>;

export type NullQueryParameter = Readonly<
  EncodedQueryParameterBrand & {
    format: 'null';
    typeOid: number;
  }
>;

export type EncodedQueryParameter = TextQueryParameter | BinaryQueryParameter | NullQueryParameter;

export type QueryParam =
  | null
  | string
  | number
  | bigint
  | boolean
  | Date
  | QueryBinaryInput
  | Readonly<Record<string, unknown>>
  | ReadonlyArray<unknown>
  | EncodedQueryParameter;

export type QueryParameterEncoder = (value: QueryParam, typeOid: number) => EncodedQueryParameter;

export type QueryFormat = 'text' | 'binary' | { code: number; kind: 'other' };

export type QueryField = {
  name: string;
  tableOid: number;
  tableAttribute: number;
  typeOid: number;
  typeSize: number;
  typeModifier: number;
  format: QueryFormat;
};

export type RawQueryRow = {
  values: Array<Uint8Array | null>;
  text(column: number): string | null;
};

class ParsedRawQueryRow implements RawQueryRow {
  constructor(readonly values: Array<Uint8Array | null>) {}

  text(column: number): string | null {
    if (column < 0 || column >= this.values.length) {
      throw new Error(`query row has no column at index ${column}`);
    }
    const value = this.values[column]!;
    return value === null ? null : decodeUtf8Strict(value, 'query value');
  }
}

export type PostgresNotice = {
  severity?: string;
  localizedSeverity?: string;
  nonlocalizedSeverity?: string;
  sqlstate?: string;
  message: string;
  detail?: string;
  hint?: string;
  position?: string;
  internalPosition?: string;
  internalQuery?: string;
  whereText?: string;
  schemaName?: string;
  tableName?: string;
  columnName?: string;
  dataTypeName?: string;
  constraintName?: string;
  file?: string;
  line?: string;
  routine?: string;
  fields: PostgresErrorField[];
};

export type RawQueryResult = {
  kind: 'command' | 'rows';
  fields: QueryField[];
  rows: RawQueryRow[];
  commandTag?: string;
  rowCount: number | null;
  notices: PostgresNotice[];
  getText(row: number, column: string): string | null;
};

export type QueryValue =
  | null
  | string
  | number
  | boolean
  | Uint8Array
  | QueryValue[]
  | { [key: string]: unknown };

export type QueryObjectRow<Value = QueryValue> = Record<string, Value>;
export type QueryArrayRow<Value = QueryValue> = Value[];

export type QueryResult<Row = QueryObjectRow> = {
  kind: 'command' | 'rows';
  fields: QueryField[];
  rows: Row[];
  commandTag?: string;
  rowCount: number | null;
  notices: PostgresNotice[];
};

export type QueryValueDecoder<Value = unknown> = (value: string, field: QueryField) => Value;
export type QueryDecoderMap = Readonly<Record<number, QueryValueDecoder>>;
export type QueryRowMode = 'object' | 'array';

export type QueryOptions<
  RowMode extends QueryRowMode = QueryRowMode,
  Decoders extends QueryDecoderMap | undefined = QueryDecoderMap | undefined,
> = Readonly<{
  rowMode?: RowMode;
  valueMode?: 'decoded' | 'text';
  decoders?: Decoders;
  encoders?: Readonly<Record<number, QueryParameterEncoder>>;
}>;

type QueryModeFromOptions<Options> = Options extends { readonly rowMode?: infer Mode }
  ? Extract<Mode, QueryRowMode> extends never
    ? 'object'
    : Extract<Mode, QueryRowMode>
  : 'object';

type QueryDecoderOutput<Options> = Options extends { readonly decoders?: infer Decoders }
  ? Decoders extends QueryDecoderMap
    ? Decoders[keyof Decoders] extends QueryValueDecoder<infer Value>
      ? Value
      : never
    : never
  : never;

type QueryRowForMode<Mode extends QueryRowMode, Value> = Mode extends 'array'
  ? QueryArrayRow<Value>
  : QueryObjectRow<Value>;

/** Infer the runtime row shape from `rowMode` and custom decoder return types. */
export type InferQueryRow<Options, ExplicitRow = never> = [ExplicitRow] extends [never]
  ? QueryRowForMode<QueryModeFromOptions<Options>, QueryValue | QueryDecoderOutput<Options>>
  : ExplicitRow;

export type ParameterOptions = Readonly<{
  encoders?: Readonly<Record<number, QueryParameterEncoder>>;
}>;

export type CommandResult = {
  commandTag?: string;
  rowCount: number | null;
  notices: PostgresNotice[];
};

export type ExecResult<Row = QueryObjectRow> = {
  statements: QueryResult<Row>[];
  notices: PostgresNotice[];
};

export type DescribeResult = {
  parameterTypeOids: number[];
  fields?: QueryField[];
  notices: PostgresNotice[];
};

export type TransactionStatus = 'idle' | 'transaction' | 'failed';

export { simpleQuery };

export type PostgresErrorField = {
  code: number;
  value: string;
};

export class PostgresError extends Error {
  readonly severity?: string;
  readonly localizedSeverity?: string;
  readonly nonlocalizedSeverity?: string;
  readonly sqlstate?: string;
  readonly detail?: string;
  readonly hint?: string;
  readonly position?: string;
  readonly internalPosition?: string;
  readonly internalQuery?: string;
  readonly whereText?: string;
  readonly schemaName?: string;
  readonly tableName?: string;
  readonly columnName?: string;
  readonly dataTypeName?: string;
  readonly constraintName?: string;
  readonly file?: string;
  readonly line?: string;
  readonly routine?: string;
  readonly fields: PostgresErrorField[];
  readonly notices: PostgresNotice[];

  constructor(fields: PostgresErrorField[], notices: PostgresNotice[] = []) {
    const severity = fieldValue(fields, 0x53) ?? fieldValue(fields, 0x56);
    const sqlstate = fieldValue(fields, 0x43);
    super(fieldValue(fields, 0x4d) ?? 'PostgreSQL ErrorResponse');
    this.name = 'PostgresError';
    this.severity = severity;
    this.localizedSeverity = fieldValue(fields, 0x53);
    this.nonlocalizedSeverity = fieldValue(fields, 0x56);
    this.sqlstate = sqlstate;
    this.detail = fieldValue(fields, 0x44);
    this.hint = fieldValue(fields, 0x48);
    this.position = fieldValue(fields, 0x50);
    this.internalPosition = fieldValue(fields, 0x70);
    this.internalQuery = fieldValue(fields, 0x71);
    this.whereText = fieldValue(fields, 0x57);
    this.schemaName = fieldValue(fields, 0x73);
    this.tableName = fieldValue(fields, 0x74);
    this.columnName = fieldValue(fields, 0x63);
    this.dataTypeName = fieldValue(fields, 0x64);
    this.constraintName = fieldValue(fields, 0x6e);
    this.file = fieldValue(fields, 0x46);
    this.line = fieldValue(fields, 0x4c);
    this.routine = fieldValue(fields, 0x52);
    this.fields = fields;
    this.notices = notices;
  }
}

/** @internal Preserve query-scoped notices on caller codec failures. */
export function errorWithNotices(error: unknown, notices: ReadonlyArray<PostgresNotice>): unknown {
  if (notices.length === 0 && isObjectLike(error)) return error;
  if (isObjectLike(error) && tryAttachNotices(error, notices)) return error;

  const wrapped = withCause(new Error(codecFailureMessage(error)), error);
  if (notices.length > 0) {
    Object.defineProperty(wrapped, 'notices', {
      value: [...notices],
      configurable: true,
      enumerable: true,
    });
  }
  return wrapped;
}

function tryAttachNotices(error: object, notices: ReadonlyArray<PostgresNotice>): boolean {
  try {
    const existing = (error as { notices?: unknown }).notices;
    if (Array.isArray(existing)) {
      try {
        existing.unshift(...notices);
        return true;
      } catch {
        // Fall through to replacing a configurable property.
      }
    }
    if (!Object.isExtensible(error)) return false;
    Object.defineProperty(error, 'notices', {
      value: [...notices],
      configurable: true,
      enumerable: true,
    });
    return true;
  } catch {
    return false;
  }
}

function codecFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  if (isObjectLike(error)) {
    try {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message.length > 0) return message;
    } catch {
      // Use the stable fallback for hostile thrown objects.
    }
  }
  return 'query codec failed';
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

type ParameterMetadata =
  | { format: 'text'; value: string; typeOid?: number }
  | { format: 'binary'; value: QueryBinaryInput; typeOid?: number }
  | { format: 'null'; typeOid: number };

const parameterMetadata = new WeakMap<object, ParameterMetadata>();

export function text(
  value: string | number | bigint | boolean | Date,
  typeOid?: number,
): TextQueryParameter {
  const encoded = scalarText(value);
  return parameterWrapper({
    format: 'text',
    value: encoded,
    typeOid,
  }) as TextQueryParameter;
}

export function binary(value: QueryBinaryInput, typeOid?: number): BinaryQueryParameter {
  if (!isQueryBinaryInput(value)) {
    throw new TypeError('binary() requires an ArrayBuffer or ArrayBuffer view');
  }
  return parameterWrapper({
    format: 'binary',
    value,
    typeOid,
  }) as BinaryQueryParameter;
}

export function typedNull(typeOid: number): NullQueryParameter {
  validateTypeOid(typeOid, false);
  return parameterWrapper({ format: 'null', typeOid }) as NullQueryParameter;
}

export function json(value: unknown, typeOid: number = postgresOids.jsonb): TextQueryParameter {
  validateTypeOid(typeOid, false);
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw withCause(new TypeError('json() value must be acyclic and JSON-serializable'), error);
  }
  if (encoded === undefined) {
    throw new TypeError('json() value must be JSON-serializable');
  }
  return parameterWrapper({
    format: 'text',
    value: encoded,
    typeOid,
  }) as TextQueryParameter;
}

export function array(values: ReadonlyArray<unknown>, typeOid?: number): TextQueryParameter {
  if (!Array.isArray(values)) {
    throw new TypeError('array() requires a JavaScript array');
  }
  const elementTypeOid = typeOid === undefined ? undefined : arrayElementTypeOid(typeOid);
  if (typeOid !== undefined && elementTypeOid === undefined) {
    throw new TypeError('array() type OID ' + typeOid + ' is not a supported PostgreSQL array OID');
  }
  return parameterWrapper({
    format: 'text',
    value: encodeArrayLiteral(values, elementTypeOid),
    typeOid,
  }) as TextQueryParameter;
}

export type QueryPlan =
  | Readonly<{ kind: 'complete'; input: Uint8Array }>
  | Readonly<{
      kind: 'describe';
      input: Uint8Array;
      bind(parameterTypeOids: ReadonlyArray<number>): Uint8Array;
    }>;

export function planQuery(
  sql: string,
  parameters: ReadonlyArray<QueryParam> = [],
  options: ParameterOptions = {},
): QueryPlan {
  validateStatementInput(sql, parameters);
  assertNoTopLevelCopy(sql);
  const snapshot = Array.from(parameters, snapshotQueryParam);
  const encoders =
    options.encoders === undefined ? undefined : Object.freeze({ ...options.encoders });
  const declaredTypeOids = snapshot.map(parameterDeclaredTypeOid);
  if (declaredTypeOids.every((typeOid) => typeOid !== 0)) {
    const normalized = snapshot.map((parameter, index) =>
      normalizeQueryParam(parameter, declaredTypeOids[index]!, encoders),
    );
    return {
      kind: 'complete',
      input: encodeParseBindExecute(sql, declaredTypeOids, normalized),
    };
  }
  return {
    kind: 'describe',
    input: describeQuery(sql, declaredTypeOids),
    bind(parameterTypeOids: ReadonlyArray<number>): Uint8Array {
      if (parameterTypeOids.length !== snapshot.length) {
        throw new Error(
          'PostgreSQL described ' +
            parameterTypeOids.length +
            ' parameters, expected ' +
            snapshot.length,
        );
      }
      const normalized = snapshot.map((parameter, index) =>
        normalizeQueryParam(parameter, parameterTypeOids[index]!, encoders),
      );
      return encodeParseBindExecute(sql, parameterTypeOids, normalized);
    },
  };
}

/** Encode a one-exchange query. Untyped values require planQuery() instead. */
export function extendedQuery(
  sql: string,
  parameters: ReadonlyArray<QueryParam>,
  options: ParameterOptions = {},
): Uint8Array {
  const plan = planQuery(sql, parameters, options);
  if (plan.kind === 'describe') {
    throw new Error('extended query parameters require PostgreSQL type inference; use planQuery()');
  }
  return plan.input;
}

export function describeQuery(
  sql: string,
  parameterTypeOids: ReadonlyArray<number> = [],
): Uint8Array {
  validateStatementInput(sql, parameterTypeOids);
  for (const typeOid of parameterTypeOids) validateTypeOid(typeOid, true);
  const sqlBytes = utf8Encoder.encode(sql);
  const parseBodyLength = sqlBytes.length + 4 + parameterTypeOids.length * 4;
  const packet = new ByteWriter(parseBodyLength + 17);
  writeParse(packet, sqlBytes, parameterTypeOids);
  packet.message(0x44, 2);
  packet.u8(0x53);
  packet.u8(0);
  packet.message(0x53, 0);
  return packet.finish();
}

function encodeParseBindExecute(
  sql: string,
  parameterTypeOids: ReadonlyArray<number>,
  parameters: ReadonlyArray<NormalizedParam>,
): Uint8Array {
  const sqlBytes = utf8Encoder.encode(sql);
  const parseBodyLength = sqlBytes.length + 4 + parameterTypeOids.length * 4;
  const bindBodyLength = bindLength(parameters);
  const packet = new ByteWriter(parseBodyLength + bindBodyLength + 32);
  writeParse(packet, sqlBytes, parameterTypeOids);
  writeBindExecute(packet, parameters);
  return packet.finish();
}

function writeParse(
  packet: ByteWriter,
  sqlBytes: Uint8Array,
  parameterTypeOids: ReadonlyArray<number>,
): void {
  const parseBodyLength = sqlBytes.length + 4 + parameterTypeOids.length * 4;
  packet.message(0x50, parseBodyLength);
  packet.u8(0);
  packet.bytes(sqlBytes);
  packet.u8(0);
  packet.i16(parameterTypeOids.length);
  for (const typeOid of parameterTypeOids) packet.i32(typeOid);
}

function writeBindExecute(packet: ByteWriter, parameters: ReadonlyArray<NormalizedParam>): void {
  packet.message(0x42, bindLength(parameters));
  packet.u8(0);
  packet.u8(0);
  packet.i16(parameters.length);
  for (const parameter of parameters) packet.i16(parameter.kind === 'binary' ? 1 : 0);
  packet.i16(parameters.length);
  for (const parameter of parameters) {
    if (parameter.kind === 'null') {
      packet.i32(-1);
    } else {
      packet.i32(parameter.value.length);
      packet.bytes(parameter.value);
    }
  }
  packet.i16(1);
  packet.i16(0);
  packet.message(0x44, 2);
  packet.u8(0x50);
  packet.u8(0);
  packet.message(0x45, 5);
  packet.u8(0);
  packet.i32(0);
  packet.message(0x53, 0);
}

function bindLength(parameters: ReadonlyArray<NormalizedParam>): number {
  let length = 10 + parameters.length * 2;
  for (const parameter of parameters) {
    length += 4 + (parameter.kind === 'null' ? 0 : parameter.value.length);
  }
  return length;
}

const transactionStatuses = new WeakMap<object, TransactionStatus>();

type RawOperation = {
  statements: RawQueryResult[];
  notices: PostgresNotice[];
  transactionStatus: TransactionStatus;
};

export function responseTransactionStatus(value: object): TransactionStatus | undefined {
  return transactionStatuses.get(value);
}

/**
 * Validate the complete backend framing and return the one terminal
 * ReadyForQuery status without interpreting result values.
 *
 * Structured clients call this immediately after transport completion so a
 * custom decoder or higher-level result assertion cannot obscure whether the
 * physical PostgreSQL session reached a reusable boundary.
 */
export function inspectReadyForQuery(bytes: Uint8Array): TransactionStatus {
  return inspectResponseBoundary(bytes).status;
}

/**
 * Validate a structured callback-transaction response before high-level
 * parsing can discard earlier command tags after a later ErrorResponse.
 */
export function inspectManagedTransactionResponse(bytes: Uint8Array): TransactionStatus {
  const boundary = inspectResponseBoundary(bytes);
  if (boundary.status === 'idle') {
    throw new Error(
      'structured callback transaction operation ended PostgreSQL transaction ownership; close the database',
    );
  }
  for (const rawTag of boundary.commandTags) {
    const tag = rawTag;
    if (
      tag === 'BEGIN' ||
      tag === 'START TRANSACTION' ||
      tag === 'COMMIT' ||
      tag === 'PREPARE TRANSACTION' ||
      tag === 'COMMIT PREPARED' ||
      tag === 'ROLLBACK PREPARED'
    ) {
      throw new Error(
        `PostgreSQL command tag ${tag} violated callback transaction ownership; close the database`,
      );
    }
  }
  return boundary.status;
}

function inspectResponseBoundary(
  bytes: Uint8Array,
): Readonly<{ status: TransactionStatus; commandTags: string[] }> {
  const cursor = new ByteCursor(bytes);
  let status: TransactionStatus | undefined;
  const commandTags: string[] = [];
  while (!cursor.isAtEnd()) {
    if (status !== undefined) {
      throw new Error('backend returned bytes after ReadyForQuery');
    }
    const tag = cursor.readU8('backend message tag');
    const length = cursor.readI32('backend message length');
    if (length < 4) throw new Error('invalid backend message length ' + length);
    const body = new ByteCursor(cursor.readBytes(length - 4, 'backend message body'));
    if (tag === 0x43) {
      commandTags.push(body.readCString('CommandComplete tag'));
      body.requireEnd('CommandComplete');
    } else if (tag === 0x5a) {
      status = parseReadyForQuery(body);
    }
  }
  if (status === undefined) {
    throw new Error('backend response ended before ReadyForQuery');
  }
  return { status, commandTags };
}

export function parseQueryRawResponse(bytes: Uint8Array): RawQueryResult {
  return singleRawResult(parseRawOperation(bytes, 'extended-single'));
}

export function parseSimpleQueryRawResponse(bytes: Uint8Array): RawQueryResult {
  return singleRawResult(parseRawOperation(bytes, 'simple-single'));
}

function singleRawResult(operation: RawOperation): RawQueryResult {
  const result =
    operation.statements[0] ?? rawResult('command', [], [], undefined, operation.notices);
  if (operation.statements.length === 1) result.notices = operation.notices;
  transactionStatuses.set(result, operation.transactionStatus);
  return result;
}

export function decodeQueryResult<Row = never, const Options extends QueryOptions = {}>(
  raw: RawQueryResult,
  options: Options & QueryOptions = {} as Options & QueryOptions,
): QueryResult<InferQueryRow<Options, Row>> {
  let stableOptions: QueryOptions;
  let rows: InferQueryRow<Options, Row>[];
  try {
    stableOptions = {
      rowMode: options.rowMode,
      valueMode: options.valueMode,
      decoders: options.decoders === undefined ? undefined : Object.freeze({ ...options.decoders }),
    };
    if (stableOptions.rowMode !== 'array') assertUniqueObjectRowFields(raw.fields);
    rows = raw.rows.map((row) => materializeRow(row, raw.fields, stableOptions)) as InferQueryRow<
      Options,
      Row
    >[];
  } catch (error) {
    const failure = errorWithNotices(error, raw.notices);
    const status = responseTransactionStatus(raw);
    if (status !== undefined && isObjectLike(failure)) {
      transactionStatuses.set(failure, status);
    }
    throw failure;
  }
  const result: QueryResult<InferQueryRow<Options, Row>> = {
    kind: raw.kind,
    fields: raw.fields,
    rows,
    commandTag: raw.commandTag,
    rowCount: raw.rowCount,
    notices: raw.notices,
  };
  const status = responseTransactionStatus(raw);
  if (status !== undefined) transactionStatuses.set(result, status);
  return result;
}

export function parseExecResponse<
  Row = never,
  const Options extends Omit<QueryOptions, 'encoders'> = {},
>(
  bytes: Uint8Array,
  options: Options & Omit<QueryOptions, 'encoders'> = {} as Options &
    Omit<QueryOptions, 'encoders'>,
): ExecResult<InferQueryRow<Options, Row>> {
  const operation = parseRawOperation(bytes, 'simple-exec');
  let result: ExecResult<InferQueryRow<Options, Row>>;
  try {
    result = {
      statements: operation.statements.map((statement) => {
        const decoded = decodeQueryResult<Row, Options>({ ...statement, notices: [] }, options);
        decoded.notices = statement.notices;
        return decoded;
      }),
      notices: operation.notices,
    };
  } catch (error) {
    const failure = errorWithNotices(error, operation.notices);
    if (isObjectLike(failure)) {
      transactionStatuses.set(failure, operation.transactionStatus);
    }
    throw failure;
  }
  transactionStatuses.set(result, operation.transactionStatus);
  return result;
}

export function parseCommandResponse(bytes: Uint8Array): CommandResult {
  const raw = parseQueryRawResponse(bytes);
  const status = responseTransactionStatus(raw);
  if (raw.kind === 'rows') {
    throwWithStatus(new Error('execute() received rows; use query() for row results'), status);
  }
  const result: CommandResult = {
    commandTag: raw.commandTag,
    rowCount: raw.rowCount,
    notices: raw.notices,
  };
  if (status !== undefined) transactionStatuses.set(result, status);
  return result;
}

export function parseDescribeResponse(bytes: Uint8Array): DescribeResult {
  const cursor = new ByteCursor(bytes);
  const notices: PostgresNotice[] = [];
  let parameterTypeOids: number[] | undefined;
  let fields: QueryField[] | undefined;
  let sawParseComplete = false;
  let sawNoData = false;
  let failure: Error | undefined;
  let recoveryFailure: Error | undefined;
  let sawErrorResponse = false;
  let status: TransactionStatus | undefined;
  while (!cursor.isAtEnd()) {
    const tag = cursor.readU8('backend message tag');
    const length = cursor.readI32('backend message length');
    if (length < 4) throw new Error('invalid backend message length ' + length);
    const body = new ByteCursor(cursor.readBytes(length - 4, 'backend message body'));
    if (sawErrorResponse && tag !== 0x4e && tag !== 0x53 && tag !== 0x41 && tag !== 0x5a) {
      recoveryFailure ??= withCause(
        new Error('describe response contained ' + hexBackendTag(tag) + ' after ErrorResponse'),
        failure,
      );
      continue;
    }
    try {
      switch (tag) {
        case 0x31:
          if (sawParseComplete) throw new Error('duplicate ParseComplete');
          body.requireEnd('ParseComplete');
          sawParseComplete = true;
          break;
        case 0x74:
          if (!sawParseComplete)
            throw new Error('ParameterDescription arrived before ParseComplete');
          if (parameterTypeOids !== undefined) throw new Error('duplicate ParameterDescription');
          parameterTypeOids = parseParameterDescription(body);
          body.requireEnd('ParameterDescription');
          break;
        case 0x54:
          if (parameterTypeOids === undefined)
            throw new Error('RowDescription arrived before ParameterDescription');
          if (fields !== undefined || sawNoData) throw new Error('duplicate result description');
          fields = parseRowDescription(body);
          body.requireEnd('RowDescription');
          break;
        case 0x6e:
          if (parameterTypeOids === undefined)
            throw new Error('NoData arrived before ParameterDescription');
          if (fields !== undefined || sawNoData) throw new Error('duplicate result description');
          sawNoData = true;
          body.requireEnd('NoData');
          break;
        case 0x45: {
          const postgresFailure = parseErrorResponse(body, notices);
          if (
            sawParseComplete &&
            parameterTypeOids !== undefined &&
            (fields !== undefined || sawNoData)
          ) {
            failure ??= withCause(
              new Error('ErrorResponse arrived after describe completion'),
              postgresFailure,
            );
          } else {
            failure ??= postgresFailure;
          }
          sawErrorResponse = true;
          break;
        }
        case 0x4e:
          notices.push(parseNoticeResponse(body));
          break;
        case 0x53:
          validateParameterStatus(body);
          break;
        case 0x41:
          validateNotificationResponse(body);
          break;
        case 0x5a:
          status = parseReadyForQuery(body);
          if (!cursor.isAtEnd()) {
            failure ??= new Error('backend returned bytes after ReadyForQuery');
            cursor.discardRemaining();
          }
          break;
        default:
          failure ??= new Error(
            'describe() received unexpected backend message tag ' + hexBackendTag(tag),
          );
      }
    } catch (error) {
      failure ??= asError(error);
    }
  }
  if (status === undefined) {
    if (failure !== undefined) throw failure;
    throw new Error('describe response ended before ReadyForQuery');
  }
  if (recoveryFailure !== undefined) throwWithStatus(recoveryFailure, status);
  if (failure !== undefined) throwWithStatus(failure, status);
  if (!sawParseComplete) {
    throwWithStatus(new Error('describe response omitted ParseComplete'), status);
  }
  if (parameterTypeOids === undefined) {
    throwWithStatus(new Error('describe response omitted ParameterDescription'), status);
  }
  if (fields === undefined && !sawNoData) {
    throwWithStatus(new Error('describe response omitted RowDescription or NoData'), status);
  }
  const result: DescribeResult = {
    parameterTypeOids,
    ...(fields === undefined ? {} : { fields }),
    notices,
  };
  transactionStatuses.set(result, status);
  return result;
}

export function assertSuccessfulQueryResponse(bytes: Uint8Array): void {
  const raw = singleRawResult(parseRawOperation(bytes, 'simple-single'));
  if (raw.kind === 'rows') {
    throwWithStatus(
      new Error('command response unexpectedly contained rows'),
      responseTransactionStatus(raw),
    );
  }
}

type RawOperationMode = 'extended-single' | 'simple-single' | 'simple-exec';

function parseRawOperation(bytes: Uint8Array, mode: RawOperationMode): RawOperation {
  const cursor = new ByteCursor(bytes);
  const statements: RawQueryResult[] = [];
  const notices: PostgresNotice[] = [];
  let statementNotices: PostgresNotice[] = [];
  let fields: QueryField[] | undefined;
  let rows: RawQueryRow[] = [];
  let failure: Error | undefined;
  let recoveryFailure: Error | undefined;
  let sawErrorResponse = false;
  let completionCount = 0;
  let extendedStage: 'start' | 'parsed' | 'bound' | 'described' | 'completed' = 'start';
  let status: TransactionStatus | undefined;
  while (!cursor.isAtEnd()) {
    const tag = cursor.readU8('backend message tag');
    const length = cursor.readI32('backend message length');
    if (length < 4) throw new Error('invalid backend message length ' + length);
    const body = new ByteCursor(cursor.readBytes(length - 4, 'backend message body'));
    if (sawErrorResponse && tag !== 0x4e && tag !== 0x53 && tag !== 0x41 && tag !== 0x5a) {
      recoveryFailure ??= withCause(
        new Error('query response contained ' + hexBackendTag(tag) + ' after ErrorResponse'),
        failure,
      );
      continue;
    }
    try {
      switch (tag) {
        case 0x54:
          if (mode !== 'simple-exec' && completionCount > 0)
            throw new Error('RowDescription arrived after statement completion');
          if (mode === 'extended-single') {
            if (extendedStage !== 'bound') {
              throw new Error('RowDescription arrived before ParseComplete and BindComplete');
            }
            extendedStage = 'described';
          }
          if (fields !== undefined) failure ??= new Error('result received two RowDescriptions');
          fields = parseRowDescription(body);
          body.requireEnd('RowDescription');
          break;
        case 0x44:
          if (completionCount > 0 && fields === undefined)
            throw new Error('DataRow arrived after statement completion');
          if (fields === undefined) throw new Error('DataRow arrived before RowDescription');
          if (mode === 'extended-single' && extendedStage !== 'described') {
            throw new Error('DataRow arrived before the result description');
          }
          rows.push(parseDataRow(body, fields.length));
          body.requireEnd('DataRow');
          break;
        case 0x43: {
          if (mode !== 'simple-exec' && completionCount > 0) {
            throw new Error(
              'queryRaw() received multiple result completions; use exec() for multi-statement SQL',
            );
          }
          if (mode === 'extended-single' && extendedStage !== 'described') {
            throw new Error('CommandComplete arrived before the extended-query result description');
          }
          const commandTag = body.readCString('CommandComplete tag');
          body.requireEnd('CommandComplete');
          statements.push(
            rawResult(
              fields === undefined ? 'command' : 'rows',
              fields ?? [],
              rows,
              commandTag,
              statementNotices,
            ),
          );
          fields = undefined;
          rows = [];
          statementNotices = [];
          completionCount += 1;
          if (mode === 'extended-single') {
            extendedStage = 'completed';
          }
          break;
        }
        case 0x45: {
          const postgresFailure = parseErrorResponse(body, notices);
          if (mode !== 'simple-exec' && completionCount > 0) {
            failure ??= withCause(
              new Error('ErrorResponse arrived after statement completion'),
              postgresFailure,
            );
          } else {
            failure ??= postgresFailure;
          }
          sawErrorResponse = true;
          break;
        }
        case 0x47:
        case 0x48:
        case 0x57:
        case 0x64:
        case 0x63:
          failure ??= new Error(
            'query() does not support COPY protocol responses; use a raw protocol API for COPY traffic',
          );
          break;
        case 0x5a:
          status = parseReadyForQuery(body);
          if (!cursor.isAtEnd()) {
            failure ??= new Error('backend returned bytes after ReadyForQuery');
            cursor.discardRemaining();
          }
          break;
        case 0x31:
          if (mode !== 'extended-single') {
            throw new Error('simple-query response contained ParseComplete');
          }
          if (extendedStage !== 'start') {
            throw new Error('ParseComplete arrived out of order');
          }
          body.requireEnd('ParseComplete');
          extendedStage = 'parsed';
          break;
        case 0x32:
          if (mode !== 'extended-single') {
            throw new Error('simple-query response contained BindComplete');
          }
          if (extendedStage !== 'parsed') {
            throw new Error('BindComplete arrived before ParseComplete or out of order');
          }
          body.requireEnd('BindComplete');
          extendedStage = 'bound';
          break;
        case 0x33:
          throw new Error('unsolicited CloseComplete in query response');
        case 0x49:
          if (fields !== undefined || rows.length !== 0)
            throw new Error('EmptyQueryResponse arrived during a row result');
          if (mode !== 'simple-exec' && completionCount > 0) {
            throw new Error(
              'queryRaw() received multiple result completions; use exec() for multi-statement SQL',
            );
          }
          if (mode === 'extended-single' && extendedStage !== 'described') {
            throw new Error(
              'EmptyQueryResponse arrived before the extended-query result description',
            );
          }
          body.requireEnd('EmptyQueryResponse');
          statementNotices = [];
          completionCount += 1;
          if (mode === 'extended-single') {
            extendedStage = 'completed';
          }
          break;
        case 0x6e:
          if (mode !== 'extended-single') {
            throw new Error('simple-query response contained NoData');
          }
          if (extendedStage !== 'bound') {
            throw new Error('NoData arrived before ParseComplete and BindComplete');
          }
          body.requireEnd('NoData');
          extendedStage = 'described';
          break;
        case 0x53:
          validateParameterStatus(body);
          break;
        case 0x4e: {
          const notice = parseNoticeResponse(body);
          notices.push(notice);
          statementNotices.push(notice);
          break;
        }
        case 0x41:
          validateNotificationResponse(body);
          break;
        default:
          failure ??= new Error('unexpected backend message tag ' + hexBackendTag(tag));
      }
    } catch (error) {
      failure ??= asError(error);
    }
  }
  if (status === undefined) {
    if (failure !== undefined) throw failure;
    throw new Error('query response ended before ReadyForQuery');
  }
  if (recoveryFailure !== undefined) throwWithStatus(recoveryFailure, status);
  if (fields !== undefined || rows.length !== 0) {
    failure ??= new Error('query response ended before CommandComplete');
  }
  if (!sawErrorResponse && completionCount === 0) {
    failure ??= new Error('query response omitted CommandComplete or EmptyQueryResponse');
  }
  if (!sawErrorResponse && mode === 'extended-single' && extendedStage !== 'completed') {
    failure ??= new Error(
      'extended-query response omitted ParseComplete, BindComplete, result description, or completion',
    );
  }
  if (failure !== undefined) throwWithStatus(failure, status);
  return { statements, notices, transactionStatus: status };
}

function rawResult(
  kind: 'command' | 'rows',
  fields: QueryField[],
  rows: RawQueryRow[],
  commandTag: string | undefined,
  notices: PostgresNotice[],
): RawQueryResult {
  return {
    kind,
    fields,
    rows,
    commandTag,
    rowCount: commandTagRowCount(commandTag),
    notices,
    getText(row: number, column: string): string | null {
      const columnIndex = resolveFieldIndex(fields, column);
      const queryRow = rows[row];
      if (queryRow === undefined) throw new Error('query result has no row at index ' + row);
      return queryRow.text(columnIndex);
    },
  };
}

function resolveFieldIndex(fields: QueryField[], name: string): number {
  let match: number | undefined;
  for (let index = 0; index < fields.length; index += 1) {
    if (fields[index]!.name !== name) continue;
    if (match !== undefined) {
      throw new Error(
        'query result has more than one column named ' +
          JSON.stringify(name) +
          '; use array row mode or a positional raw-row index',
      );
    }
    match = index;
  }
  if (match === undefined) {
    throw new Error('query result has no column named ' + JSON.stringify(name));
  }
  return match;
}

function assertUniqueObjectRowFields(fields: ReadonlyArray<QueryField>): void {
  const names = new Set<string>();
  for (const field of fields) {
    if (names.has(field.name)) {
      throw new Error(
        'decoded object rows cannot represent more than one column named ' +
          JSON.stringify(field.name) +
          "; use { rowMode: 'array' } or queryRaw()",
      );
    }
    names.add(field.name);
  }
}

function materializeRow(
  row: RawQueryRow,
  fields: QueryField[],
  options: QueryOptions,
): QueryObjectRow | QueryArrayRow {
  const values = row.values.map((value, index) => decodeValue(value, fields[index]!, options));
  if (options.rowMode === 'array') return values;
  const object: QueryObjectRow = {};
  for (let index = 0; index < fields.length; index += 1) {
    Object.defineProperty(object, fields[index]!.name, {
      value: values[index]!,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return object;
}

function decodeValue(
  value: Uint8Array | null,
  field: QueryField,
  options: QueryOptions,
): QueryValue {
  if (value === null) return null;
  if (field.format !== 'text') return value;
  const decodedText = decodeUtf8Strict(value, 'query value');
  const decoder = options.decoders?.[field.typeOid];
  if (decoder !== undefined) return decoder(decodedText, field) as QueryValue;
  if (options.valueMode === 'text') return decodedText;
  return decodeBuiltInText(decodedText, field.typeOid);
}

function commandTagRowCount(commandTag: string | undefined): number | null {
  if (commandTag === undefined) {
    return null;
  }
  const parts = commandTag.trim().split(/\s+/);
  const count = parts.at(-1);
  if (
    count === undefined ||
    !/^[0-9]+$/.test(count) ||
    !['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'MOVE', 'FETCH', 'COPY'].includes(parts[0]!)
  ) {
    return null;
  }
  const value = Number(count);
  return Number.isSafeInteger(value) ? value : null;
}

type NormalizedParam =
  | { kind: 'null' }
  | { kind: 'text'; value: Uint8Array }
  | { kind: 'binary'; value: Uint8Array };

function normalizeQueryParam(
  parameter: QueryParam,
  typeOid: number,
  encoders: Readonly<Record<number, QueryParameterEncoder>> | undefined,
): NormalizedParam {
  validateTypeOid(typeOid, false);
  const wrapper =
    parameter !== null && typeof parameter === 'object'
      ? parameterMetadata.get(parameter)
      : undefined;
  if (wrapper !== undefined) return normalizeWrapper(wrapper, typeOid);

  const custom = encoders?.[typeOid];
  if (custom !== undefined) {
    const encoded = custom(parameter, typeOid);
    if (encoded === null || typeof encoded !== 'object') {
      throw new TypeError('query encoder for OID ' + typeOid + ' must return a parameter helper');
    }
    const encodedMetadata = parameterMetadata.get(encoded);
    if (encodedMetadata === undefined) {
      throw new TypeError(
        'query encoder for OID ' + typeOid + ' must use text(), binary(), or typedNull()',
      );
    }
    return normalizeWrapper(encodedMetadata, typeOid);
  }

  if (parameter === null) return { kind: 'null' };
  if (typeof parameter === 'string') {
    return { kind: 'text', value: utf8Encoder.encode(parameter) };
  }
  if (typeof parameter === 'number') {
    if (!isNumericOrTextOid(typeOid)) throw unsupportedParameter(parameter, typeOid);
    return { kind: 'text', value: utf8Encoder.encode(scalarText(parameter)) };
  }
  if (typeof parameter === 'bigint') {
    if (!isNumericOrTextOid(typeOid)) throw unsupportedParameter(parameter, typeOid);
    return { kind: 'text', value: utf8Encoder.encode(parameter.toString()) };
  }
  if (typeof parameter === 'boolean') {
    if (typeOid !== postgresOids.bool && !isTextOid(typeOid)) {
      throw unsupportedParameter(parameter, typeOid);
    }
    return {
      kind: 'text',
      value: utf8Encoder.encode(parameter ? 'true' : 'false'),
    };
  }
  if (parameter instanceof Date) {
    return {
      kind: 'text',
      value: utf8Encoder.encode(dateText(parameter, typeOid)),
    };
  }
  if (isQueryBinaryInput(parameter)) {
    if (typeOid !== postgresOids.bytea) throw unsupportedParameter(parameter, typeOid);
    return { kind: 'binary', value: toUint8Array(parameter) };
  }
  if (Array.isArray(parameter)) {
    const elementTypeOid = arrayElementTypeOid(typeOid);
    if (elementTypeOid === undefined) throw unsupportedParameter(parameter, typeOid);
    return {
      kind: 'text',
      value: utf8Encoder.encode(encodeArrayLiteral(parameter, elementTypeOid)),
    };
  }
  if (isPlainRecord(parameter)) {
    if (typeOid !== postgresOids.json && typeOid !== postgresOids.jsonb) {
      throw unsupportedParameter(parameter, typeOid);
    }
    return { kind: 'text', value: utf8Encoder.encode(json(parameter).value) };
  }
  throw new TypeError('query parameter is unsupported; use an explicit parameter helper');
}

function normalizeWrapper(wrapper: ParameterMetadata, typeOid: number): NormalizedParam {
  if (wrapper.typeOid !== undefined && wrapper.typeOid !== typeOid) {
    throw new Error(
      'parameter declares PostgreSQL OID ' +
        wrapper.typeOid +
        ', but PostgreSQL described OID ' +
        typeOid,
    );
  }
  if (wrapper.format === 'null') return { kind: 'null' };
  if (wrapper.format === 'text') {
    return { kind: 'text', value: utf8Encoder.encode(wrapper.value) };
  }
  return { kind: 'binary', value: toUint8Array(wrapper.value) };
}

function parameterDeclaredTypeOid(parameter: QueryParam): number {
  if (parameter !== null && typeof parameter === 'object') {
    const wrapper = parameterMetadata.get(parameter);
    if (wrapper?.typeOid !== undefined) {
      validateTypeOid(wrapper.typeOid, false);
      return wrapper.typeOid;
    }
  }
  return 0;
}

function snapshotQueryParam(parameter: QueryParam): QueryParam {
  if (
    parameter === null ||
    typeof parameter === 'string' ||
    typeof parameter === 'number' ||
    typeof parameter === 'bigint' ||
    typeof parameter === 'boolean'
  ) {
    return parameter;
  }
  if (parameter === undefined) throw new TypeError('query parameters must not be undefined');
  const wrapper = typeof parameter === 'object' ? parameterMetadata.get(parameter) : undefined;
  if (wrapper !== undefined) {
    if (wrapper.format === 'null') return typedNull(wrapper.typeOid);
    if (wrapper.format === 'binary') {
      return binary(toUint8Array(wrapper.value).slice(), wrapper.typeOid);
    }
    return text(wrapper.value, wrapper.typeOid);
  }
  if (parameter instanceof Date) return new Date(parameter.getTime());
  if (isQueryBinaryInput(parameter)) return toUint8Array(parameter).slice();
  if (Array.isArray(parameter))
    return Array.from(parameter, (value) => snapshotQueryParam(value as QueryParam));
  if (isPlainRecord(parameter)) {
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(parameter);
    } catch (error) {
      throw withCause(
        new TypeError('plain-object query parameters must be JSON-serializable'),
        error,
      );
    }
    if (encoded === undefined)
      throw new TypeError('plain-object query parameters must be JSON-serializable');
    return JSON.parse(encoded) as Readonly<Record<string, unknown>>;
  }
  throw new TypeError('query parameter is unsupported; use an explicit parameter helper');
}

function parameterWrapper(metadata: ParameterMetadata): EncodedQueryParameter {
  if (metadata.typeOid !== undefined) validateTypeOid(metadata.typeOid, false);
  const visible =
    metadata.format === 'null'
      ? { format: 'null' as const, typeOid: metadata.typeOid }
      : {
          format: metadata.format,
          value: metadata.value,
          ...(metadata.typeOid === undefined ? {} : { typeOid: metadata.typeOid }),
        };
  const wrapper = Object.freeze(visible) as EncodedQueryParameter;
  parameterMetadata.set(wrapper, metadata);
  return wrapper;
}

function isQueryBinaryInput(value: unknown): value is QueryBinaryInput {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function validateStatementInput(sql: string, parameters: { length: number }): void {
  if (parameters.length > 0x7fff) {
    throw new Error('extended query supports at most 32767 parameters, got ' + parameters.length);
  }
  if (sql.includes('\0')) throw new Error('extended query SQL must not contain NUL bytes');
}

function validateTypeOid(typeOid: number, allowZero: boolean): void {
  if (!Number.isInteger(typeOid) || typeOid < (allowZero ? 0 : 1) || typeOid > 0xffffffff) {
    throw new TypeError(
      'PostgreSQL type OID must be ' + (allowZero ? 'zero or ' : '') + 'a positive uint32',
    );
  }
}

function scalarText(value: string | number | bigint | boolean | Date): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('number query parameters must be finite');
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError('integer query parameters must be safe integers; use bigint instead');
    }
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('Date query parameters must be valid');
    return value.toISOString();
  }
  return String(value);
}

function dateText(value: Date, typeOid: number): string {
  const iso = scalarText(value);
  if (typeOid === postgresOids.date) return iso.slice(0, 10);
  if (typeOid === postgresOids.timestamp) return iso.slice(0, -1).replace('T', ' ');
  if (typeOid === postgresOids.timestamptz || isTextOid(typeOid)) return iso;
  throw unsupportedParameter(value, typeOid);
}

function isNumericOrTextOid(typeOid: number): boolean {
  return (
    (
      [
        postgresOids.int2,
        postgresOids.int4,
        postgresOids.int8,
        postgresOids.oid,
        postgresOids.float4,
        postgresOids.float8,
        postgresOids.numeric,
      ] as number[]
    ).includes(typeOid) || isTextOid(typeOid)
  );
}

function isTextOid(typeOid: number): boolean {
  return typeOid === postgresOids.text || typeOid === postgresOids.varchar;
}

function unsupportedParameter(value: unknown, typeOid: number): TypeError {
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  return new TypeError(
    'cannot safely encode ' +
      kind +
      ' for PostgreSQL OID ' +
      typeOid +
      '; use a typed helper or encoder',
  );
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function throwWithStatus(error: Error, status: TransactionStatus | undefined): never {
  if (status !== undefined) transactionStatuses.set(error, status);
  throw error;
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : withCause(new Error('PostgreSQL response parsing failed'), error);
}

function withCause<ErrorType extends Error>(error: ErrorType, cause: unknown): ErrorType {
  Object.defineProperty(error, 'cause', {
    value: cause,
    configurable: true,
    writable: true,
  });
  return error;
}

function decodeBuiltInText(value: string, typeOid: number): QueryValue {
  switch (typeOid) {
    case postgresOids.bool:
      if (value === 't') return true;
      if (value === 'f') return false;
      throw new Error('invalid PostgreSQL bool text ' + JSON.stringify(value));
    case postgresOids.int2:
    case postgresOids.int4:
    case postgresOids.oid:
      return decodeInteger(value, typeOid);
    case postgresOids.float4:
    case postgresOids.float8:
      return decodeFloat(value, typeOid);
    case postgresOids.json:
    case postgresOids.jsonb:
      return JSON.parse(value) as QueryValue;
    case postgresOids.bytea:
      return decodeBytea(value);
    case postgresOids.int8:
    case postgresOids.numeric:
    case postgresOids.date:
    case postgresOids.time:
    case postgresOids.timestamp:
    case postgresOids.timestamptz:
    case postgresOids.interval:
    case postgresOids.timetz:
      return value;
    default: {
      const elementTypeOid = arrayElementTypeOid(typeOid);
      if (elementTypeOid === undefined) return value;
      return decodeArrayLiteral(value, elementTypeOid);
    }
  }
}

function decodeInteger(value: string, typeOid: number): number {
  if (!/^-?[0-9]+$/.test(value)) {
    throw new Error(
      'invalid PostgreSQL integer text for OID ' + typeOid + ': ' + JSON.stringify(value),
    );
  }
  const decoded = Number(value);
  if (!Number.isSafeInteger(decoded)) {
    throw new Error('PostgreSQL integer for OID ' + typeOid + ' exceeds JavaScript safe range');
  }
  return decoded;
}

function decodeFloat(value: string, typeOid: number): number {
  if (value === 'NaN') return Number.NaN;
  if (value === 'Infinity') return Number.POSITIVE_INFINITY;
  if (value === '-Infinity') return Number.NEGATIVE_INFINITY;
  if (!/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(value)) {
    throw new Error(
      'invalid PostgreSQL float text for OID ' + typeOid + ': ' + JSON.stringify(value),
    );
  }
  const decoded = Number(value);
  if (!Number.isFinite(decoded))
    throw new Error('PostgreSQL float text is outside JavaScript range');
  return decoded;
}

function decodeBytea(value: string): Uint8Array {
  if (value.startsWith('\\x')) {
    const hex = value.slice(2);
    if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
      throw new Error('invalid PostgreSQL hex bytea text');
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\\') {
      bytes.push(value.charCodeAt(index));
      continue;
    }
    if (value[index + 1] === '\\') {
      bytes.push(0x5c);
      index += 1;
      continue;
    }
    const octal = value.slice(index + 1, index + 4);
    if (!/^[0-3][0-7]{2}$/.test(octal)) throw new Error('invalid PostgreSQL escape bytea text');
    bytes.push(Number.parseInt(octal, 8));
    index += 3;
  }
  return Uint8Array.from(bytes);
}

const arrayElementOids = new Map<number, number>([
  [postgresOids.boolArray, postgresOids.bool],
  [postgresOids.byteaArray, postgresOids.bytea],
  [postgresOids.charArray, postgresOids.char],
  [postgresOids.nameArray, postgresOids.name],
  [postgresOids.int2Array, postgresOids.int2],
  [postgresOids.int4Array, postgresOids.int4],
  [postgresOids.textArray, postgresOids.text],
  [postgresOids.bpcharArray, postgresOids.bpchar],
  [postgresOids.varcharArray, postgresOids.varchar],
  [postgresOids.int8Array, postgresOids.int8],
  [postgresOids.float4Array, postgresOids.float4],
  [postgresOids.float8Array, postgresOids.float8],
  [postgresOids.oidArray, postgresOids.oid],
  [postgresOids.dateArray, postgresOids.date],
  [postgresOids.timeArray, postgresOids.time],
  [postgresOids.timestampArray, postgresOids.timestamp],
  [postgresOids.timestamptzArray, postgresOids.timestamptz],
  [postgresOids.intervalArray, postgresOids.interval],
  [postgresOids.numericArray, postgresOids.numeric],
  [postgresOids.timetzArray, postgresOids.timetz],
  [postgresOids.jsonArray, postgresOids.json],
  [postgresOids.xmlArray, postgresOids.xml],
  [postgresOids.uuidArray, postgresOids.uuid],
  [postgresOids.jsonbArray, postgresOids.jsonb],
]);

function arrayElementTypeOid(arrayTypeOid: number): number | undefined {
  return arrayElementOids.get(arrayTypeOid);
}

function encodeArrayLiteral(values: ReadonlyArray<unknown>, elementTypeOid?: number): string {
  return (
    '{' + Array.from(values, (value) => encodeArrayElement(value, elementTypeOid)).join(',') + '}'
  );
}

function encodeArrayElement(value: unknown, elementTypeOid?: number): string {
  if (value === null) return 'NULL';
  if (value === undefined) throw new TypeError('PostgreSQL arrays cannot contain undefined');
  if (Array.isArray(value)) return encodeArrayLiteral(value, elementTypeOid);
  const wrapper =
    typeof value === 'object' && value !== null ? parameterMetadata.get(value) : undefined;
  if (wrapper !== undefined) {
    if (
      elementTypeOid !== undefined &&
      wrapper.typeOid !== undefined &&
      wrapper.typeOid !== elementTypeOid
    ) {
      throw new TypeError(
        'array element declares PostgreSQL OID ' +
          wrapper.typeOid +
          ', but the array resolves element OID ' +
          elementTypeOid,
      );
    }
    if (wrapper.format === 'null') return 'NULL';
    if (wrapper.format === 'binary') {
      if (elementTypeOid !== undefined && elementTypeOid !== postgresOids.bytea) {
        throw unsupportedParameter(value, elementTypeOid);
      }
      return quoteArrayElement('\\x' + bytesToHex(toUint8Array(wrapper.value)));
    }
    return quoteArrayElement(wrapper.value);
  }
  if (typeof value === 'string') return quoteArrayElement(value);
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    if (elementTypeOid !== undefined) {
      normalizeQueryParam(value as QueryParam, elementTypeOid, undefined);
    }
    return quoteArrayElement(scalarText(value));
  }
  if (value instanceof Date) {
    return quoteArrayElement(
      elementTypeOid === undefined ? scalarText(value) : dateText(value, elementTypeOid),
    );
  }
  if (isQueryBinaryInput(value)) {
    if (elementTypeOid !== undefined && elementTypeOid !== postgresOids.bytea) {
      throw unsupportedParameter(value, elementTypeOid);
    }
    return quoteArrayElement('\\x' + bytesToHex(toUint8Array(value)));
  }
  if (
    isPlainRecord(value) &&
    (elementTypeOid === postgresOids.json || elementTypeOid === postgresOids.jsonb)
  ) {
    return quoteArrayElement(json(value, elementTypeOid).value);
  }
  throw new TypeError('PostgreSQL array element is unsupported; use an explicit helper');
}

function quoteArrayElement(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

type ParsedArrayValue = string | null | ParsedArrayValue[];

function decodeArrayLiteral(value: string, elementTypeOid: number): QueryValue[] {
  const parsed = new ArrayTextParser(value).parse();
  return decodeArrayValues(parsed, elementTypeOid);
}

function decodeArrayValues(values: ParsedArrayValue[], elementTypeOid: number): QueryValue[] {
  return values.map((value) =>
    Array.isArray(value)
      ? decodeArrayValues(value, elementTypeOid)
      : value === null
        ? null
        : decodeBuiltInText(value, elementTypeOid),
  );
}

class ArrayTextParser {
  readonly #input: string;
  #offset = 0;

  constructor(input: string) {
    this.#input = input;
  }

  parse(): ParsedArrayValue[] {
    if (this.#input.startsWith('[')) {
      const separator = this.#input.indexOf('=');
      if (separator < 0) throw new Error('invalid PostgreSQL array dimensions');
      this.#offset = separator + 1;
    }
    const result = this.#level();
    if (this.#offset !== this.#input.length)
      throw new Error('PostgreSQL array text has trailing data');
    return result;
  }

  #level(): ParsedArrayValue[] {
    if (this.#input[this.#offset] !== '{')
      throw new Error('PostgreSQL array text must start with {');
    this.#offset += 1;
    const result: ParsedArrayValue[] = [];
    if (this.#input[this.#offset] === '}') {
      this.#offset += 1;
      return result;
    }
    for (;;) {
      result.push(this.#input[this.#offset] === '{' ? this.#level() : this.#element());
      const delimiter = this.#input[this.#offset];
      if (delimiter === '}') {
        this.#offset += 1;
        return result;
      }
      if (delimiter !== ',') throw new Error('invalid PostgreSQL array delimiter');
      this.#offset += 1;
    }
  }

  #element(): string | null {
    if (this.#input[this.#offset] === '"') {
      this.#offset += 1;
      let value = '';
      for (;;) {
        const character = this.#input[this.#offset];
        if (character === undefined) throw new Error('unterminated quoted PostgreSQL array value');
        this.#offset += 1;
        if (character === '"') return value;
        if (character === '\\') {
          const escaped = this.#input[this.#offset];
          if (escaped === undefined) throw new Error('unterminated PostgreSQL array escape');
          value += escaped;
          this.#offset += 1;
        } else {
          value += character;
        }
      }
    }
    let value = '';
    while (this.#offset < this.#input.length) {
      const character = this.#input[this.#offset]!;
      if (character === ',' || character === '}') break;
      this.#offset += 1;
      if (character === '\\') {
        const escaped = this.#input[this.#offset];
        if (escaped === undefined) throw new Error('unterminated PostgreSQL array escape');
        value += escaped;
        this.#offset += 1;
      } else {
        value += character;
      }
    }
    return value === 'NULL' ? null : value;
  }
}

export function assertNoTopLevelCopy(sql: string): void {
  if (containsTopLevelCopy(sql)) {
    throw new Error(
      'structured SQL does not support COPY; use a raw protocol API for COPY traffic',
    );
  }
}

/**
 * Reject transaction commands whose response boundary cannot prove that the
 * callback still owns the transaction it started. PostgreSQL reports both
 * `ROLLBACK TO SAVEPOINT` and `ROLLBACK AND CHAIN` as command tag `ROLLBACK`
 * with ReadyForQuery status `transaction`, so the latter must be rejected
 * before execution rather than inferred from the backend response.
 */
export function assertNoTransactionChain(sql: string): void {
  if (containsTransactionChain(sql)) {
    throw new Error(
      'callback transactions do not support ROLLBACK/ABORT ... AND CHAIN; return or throw from the callback instead',
    );
  }
}

export function structuredSimpleQuery(sql: string): Uint8Array {
  assertNoTopLevelCopy(sql);
  return simpleQuery(sql);
}

export function containsTopLevelCopy(sql: string): boolean {
  return (
    scanTopLevelTokens(sql, false, (word, first) => first && word === 'copy') ||
    scanTopLevelTokens(sql, true, (word, first) => first && word === 'copy')
  );
}

export function containsTransactionChain(sql: string): boolean {
  return scanTransactionChain(sql, false) || scanTransactionChain(sql, true);
}

function scanTransactionChain(sql: string, plainStringsEscapeBackslashes: boolean): boolean {
  let currentStatement = -1;
  let state: 'afterControl' | 'afterQualifier' | 'afterAnd' | 'ineligible' = 'ineligible';
  return scanTopLevelTokens(sql, plainStringsEscapeBackslashes, (word, first, statement) => {
    if (statement !== currentStatement) {
      currentStatement = statement;
      state = first && (word === 'rollback' || word === 'abort') ? 'afterControl' : 'ineligible';
      return false;
    }
    if (word === undefined) {
      state = 'ineligible';
      return false;
    }
    if (state === 'afterControl' && (word === 'work' || word === 'transaction')) {
      state = 'afterQualifier';
    } else if ((state === 'afterControl' || state === 'afterQualifier') && word === 'and') {
      state = 'afterAnd';
    } else if (state === 'afterAnd' && word === 'chain') {
      return true;
    } else {
      // This also keeps ROLLBACK TO [SAVEPOINT] inside the managed transaction.
      state = 'ineligible';
    }
    return false;
  });
}

function scanTopLevelTokens(
  sql: string,
  plainStringsEscapeBackslashes: boolean,
  visit: (word: string | undefined, first: boolean, statement: number) => boolean,
): boolean {
  let offset = 0;
  let depth = 0;
  let statementStart = true;
  let statement = 0;
  while (offset < sql.length) {
    const character = sql[offset]!;
    if (/\s/.test(character)) {
      offset += 1;
      continue;
    }
    if (character === '-' && sql[offset + 1] === '-') {
      let end = offset + 2;
      while (end < sql.length && sql[end] !== '\n' && sql[end] !== '\r') end += 1;
      offset = end < sql.length ? end + 1 : sql.length;
      continue;
    }
    if (character === '/' && sql[offset + 1] === '*') {
      offset = skipBlockComment(sql, offset + 2);
      continue;
    }
    if ((character === 'e' || character === 'E') && sql[offset + 1] === "'") {
      if (depth === 0 && visit(undefined, statementStart, statement)) return true;
      statementStart = false;
      offset = skipSingleQuote(sql, offset + 1, true);
      continue;
    }
    if (character === "'") {
      if (depth === 0 && visit(undefined, statementStart, statement)) return true;
      statementStart = false;
      offset = skipSingleQuote(sql, offset, plainStringsEscapeBackslashes);
      continue;
    }
    if (character === '"') {
      if (depth === 0 && visit(undefined, statementStart, statement)) return true;
      statementStart = false;
      offset = skipDoubleQuote(sql, offset);
      continue;
    }
    if (character === '$') {
      const delimiter = dollarQuoteDelimiter(sql, offset);
      if (delimiter !== undefined) {
        if (depth === 0 && visit(undefined, statementStart, statement)) return true;
        statementStart = false;
        const end = sql.indexOf(delimiter, offset + delimiter.length);
        offset = end < 0 ? sql.length : end + delimiter.length;
        continue;
      }
    }
    if (character === '(') {
      if (depth === 0 && visit(undefined, statementStart, statement)) return true;
      depth += 1;
      statementStart = false;
      offset += 1;
      continue;
    }
    if (character === ')') {
      if (depth > 0) depth -= 1;
      offset += 1;
      continue;
    }
    if (character === ';' && depth === 0) {
      statementStart = true;
      statement += 1;
      offset += 1;
      continue;
    }
    if (isPostgresIdentifierStart(character)) {
      const start = offset;
      offset += 1;
      while (offset < sql.length && isPostgresIdentifierContinuation(sql[offset]!)) offset += 1;
      if (depth === 0 && visit(sql.slice(start, offset).toLowerCase(), statementStart, statement)) {
        return true;
      }
      statementStart = false;
      continue;
    }
    if (depth === 0 && visit(undefined, statementStart, statement)) return true;
    statementStart = false;
    offset += 1;
  }
  return false;
}

function skipBlockComment(sql: string, start: number): number {
  let depth = 1;
  let offset = start;
  while (offset < sql.length && depth > 0) {
    if (sql[offset] === '/' && sql[offset + 1] === '*') {
      depth += 1;
      offset += 2;
    } else if (sql[offset] === '*' && sql[offset + 1] === '/') {
      depth -= 1;
      offset += 2;
    } else {
      offset += 1;
    }
  }
  return offset;
}

function skipSingleQuote(sql: string, quoteOffset: number, escapeBackslash: boolean): number {
  let offset = quoteOffset + 1;
  while (offset < sql.length) {
    if (escapeBackslash && sql[offset] === '\\') {
      offset += Math.min(2, sql.length - offset);
    } else if (sql[offset] === "'" && sql[offset + 1] === "'") {
      offset += 2;
    } else if (sql[offset] === "'") {
      return offset + 1;
    } else {
      offset += 1;
    }
  }
  return offset;
}

function skipDoubleQuote(sql: string, quoteOffset: number): number {
  let offset = quoteOffset + 1;
  while (offset < sql.length) {
    if (sql[offset] === '"' && sql[offset + 1] === '"') offset += 2;
    else if (sql[offset] === '"') return offset + 1;
    else offset += 1;
  }
  return offset;
}

function dollarQuoteDelimiter(sql: string, offset: number): string | undefined {
  let end = offset + 1;
  if (sql[end] === '$') return '$$';
  if (end >= sql.length || !isPostgresIdentifierStart(sql[end]!)) return undefined;
  end += 1;
  while (end < sql.length && sql[end] !== '$' && isPostgresIdentifierContinuation(sql[end]!)) {
    end += 1;
  }
  return sql[end] === '$' ? sql.slice(offset, end + 1) : undefined;
}

function isPostgresIdentifierStart(character: string): boolean {
  const code = character.charCodeAt(0);
  return (
    character === '_' ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code >= 0x80
  );
}

function isPostgresIdentifierContinuation(character: string): boolean {
  const code = character.charCodeAt(0);
  return (
    isPostgresIdentifierStart(character) || character === '$' || (code >= 0x30 && code <= 0x39)
  );
}

class ByteWriter {
  readonly #bytes: Uint8Array;
  #offset = 0;

  constructor(length: number) {
    this.#bytes = new Uint8Array(length);
  }

  message(tag: number, bodyLength: number): void {
    this.u8(tag);
    this.i32(bodyLength + 4);
  }

  u8(value: number): void {
    this.#bytes[this.#offset] = value;
    this.#offset += 1;
  }

  i16(value: number): void {
    this.#bytes[this.#offset] = (value >>> 8) & 0xff;
    this.#bytes[this.#offset + 1] = value & 0xff;
    this.#offset += 2;
  }

  i32(value: number): void {
    this.#bytes[this.#offset] = (value >>> 24) & 0xff;
    this.#bytes[this.#offset + 1] = (value >>> 16) & 0xff;
    this.#bytes[this.#offset + 2] = (value >>> 8) & 0xff;
    this.#bytes[this.#offset + 3] = value & 0xff;
    this.#offset += 4;
  }

  bytes(value: Uint8Array): void {
    this.#bytes.set(value, this.#offset);
    this.#offset += value.length;
  }

  finish(): Uint8Array {
    if (this.#offset !== this.#bytes.length) {
      throw new Error('extended query packet length invariant failed');
    }
    return this.#bytes;
  }
}

export function toUint8Array(input: ByteInput): Uint8Array {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  return Uint8Array.from(input);
}

function parseRowDescription(cursor: ByteCursor): QueryField[] {
  const count = cursor.readI16('RowDescription field count');
  if (count < 0) {
    throw new Error(`invalid RowDescription field count ${count}`);
  }
  const fields: QueryField[] = [];
  for (let index = 0; index < count; index += 1) {
    fields.push({
      name: cursor.readCString('field name'),
      tableOid: cursor.readU32('field table oid'),
      tableAttribute: cursor.readI16('field table attribute'),
      typeOid: cursor.readU32('field type oid'),
      typeSize: cursor.readI16('field type size'),
      typeModifier: cursor.readI32('field type modifier'),
      format: queryFormat(cursor.readI16('field format')),
    });
  }
  return fields;
}

function parseDataRow(cursor: ByteCursor, expectedColumns: number): RawQueryRow {
  const count = cursor.readI16('DataRow column count');
  if (count < 0) {
    throw new Error(`invalid DataRow column count ${count}`);
  }
  if (count !== expectedColumns) {
    throw new Error(
      `DataRow column count ${count} does not match RowDescription count ${expectedColumns}`,
    );
  }
  const values = new Array<Uint8Array | null>(count);
  for (let index = 0; index < count; index += 1) {
    const length = cursor.readI32('DataRow value length');
    if (length === -1) {
      values[index] = null;
    } else if (length < 0) {
      throw new Error(`invalid DataRow value length ${length}`);
    } else {
      values[index] = cursor.readBytes(length, 'DataRow value');
    }
  }
  return new ParsedRawQueryRow(values);
}

function parseErrorResponse(cursor: ByteCursor, notices: PostgresNotice[] = []): PostgresError {
  return new PostgresError(parseDiagnosticFields(cursor, 'ErrorResponse'), notices);
}

function fieldValue(fields: ReadonlyArray<PostgresErrorField>, code: number): string | undefined {
  return fields.find((field) => field.code === code)?.value;
}

function queryFormat(code: number): QueryFormat {
  if (code === 0) {
    return 'text';
  }
  if (code === 1) {
    return 'binary';
  }
  return { code, kind: 'other' };
}

function hexBackendTag(tag: number): string {
  return `0x${tag.toString(16).padStart(2, '0')}`;
}

function parseReadyForQuery(body: ByteCursor): TransactionStatus {
  const remaining = body.remainingBytes();
  if (remaining !== 1) {
    throw new Error(`ReadyForQuery contained ${remaining} bytes, expected 1`);
  }
  const status = body.readU8('ReadyForQuery transaction status');
  if (status === 0x49) return 'idle';
  if (status === 0x54) return 'transaction';
  if (status === 0x45) return 'failed';
  throw new Error(`ReadyForQuery contained invalid transaction status ${hexBackendTag(status)}`);
}

function parseParameterDescription(body: ByteCursor): number[] {
  const count = body.readI16('ParameterDescription parameter count');
  if (count < 0) throw new Error('invalid ParameterDescription parameter count ' + count);
  const typeOids: number[] = [];
  for (let index = 0; index < count; index += 1) {
    typeOids.push(body.readU32('ParameterDescription type OID'));
  }
  return typeOids;
}

function parseNoticeResponse(body: ByteCursor): PostgresNotice {
  const fields = parseDiagnosticFields(body, 'NoticeResponse');
  return {
    severity: fieldValue(fields, 0x53) ?? fieldValue(fields, 0x56),
    localizedSeverity: fieldValue(fields, 0x53),
    nonlocalizedSeverity: fieldValue(fields, 0x56),
    sqlstate: fieldValue(fields, 0x43),
    message: fieldValue(fields, 0x4d) ?? 'PostgreSQL notice',
    detail: fieldValue(fields, 0x44),
    hint: fieldValue(fields, 0x48),
    position: fieldValue(fields, 0x50),
    internalPosition: fieldValue(fields, 0x70),
    internalQuery: fieldValue(fields, 0x71),
    whereText: fieldValue(fields, 0x57),
    schemaName: fieldValue(fields, 0x73),
    tableName: fieldValue(fields, 0x74),
    columnName: fieldValue(fields, 0x63),
    dataTypeName: fieldValue(fields, 0x64),
    constraintName: fieldValue(fields, 0x6e),
    file: fieldValue(fields, 0x46),
    line: fieldValue(fields, 0x4c),
    routine: fieldValue(fields, 0x52),
    fields,
  };
}

function parseDiagnosticFields(body: ByteCursor, label: string): PostgresErrorField[] {
  const fields: PostgresErrorField[] = [];
  for (;;) {
    if (body.isAtEnd()) throw new Error(label + ' is missing terminator');
    const code = body.readU8(label + ' field code');
    if (code === 0) {
      body.requireEnd(label);
      return fields;
    }
    fields.push({ code, value: body.readCString(label + ' field') });
  }
}

function validateParameterStatus(body: ByteCursor): void {
  body.readCString('ParameterStatus name');
  body.readCString('ParameterStatus value');
  body.requireEnd('ParameterStatus');
}

function validateNotificationResponse(body: ByteCursor): void {
  body.readI32('NotificationResponse process id');
  body.readCString('NotificationResponse channel');
  body.readCString('NotificationResponse payload');
  body.requireEnd('NotificationResponse');
}

class ByteCursor {
  readonly #bytes: Uint8Array;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  isAtEnd(): boolean {
    return this.#offset === this.#bytes.length;
  }

  remainingBytes(): number {
    return this.#bytes.length - this.#offset;
  }

  discardRemaining(): void {
    this.#offset = this.#bytes.length;
  }

  requireEnd(label: string): void {
    if (!this.isAtEnd()) {
      throw new Error(`${label} contained trailing bytes`);
    }
  }

  readU8(label: string): number {
    this.#require(1, label);
    const value = this.#bytes[this.#offset]!;
    this.#offset += 1;
    return value;
  }

  readU32(label: string): number {
    this.#require(4, label);
    const offset = this.#offset;
    this.#offset += 4;
    return (
      (this.#bytes[offset]! * 0x1000000 +
        (this.#bytes[offset + 1]! << 16) +
        (this.#bytes[offset + 2]! << 8) +
        this.#bytes[offset + 3]!) >>>
      0
    );
  }

  readI32(label: string): number {
    const value = this.readU32(label);
    return value > 0x7fffffff ? value - 0x100000000 : value;
  }

  readI16(label: string): number {
    this.#require(2, label);
    const value = (this.#bytes[this.#offset]! << 8) | this.#bytes[this.#offset + 1]!;
    this.#offset += 2;
    return value > 0x7fff ? value - 0x10000 : value;
  }

  readCString(label: string): string {
    const end = this.#bytes.indexOf(0, this.#offset);
    if (end < 0) {
      throw new Error(`${label} is missing null terminator`);
    }
    const value = decodeUtf8Strict(this.#bytes.subarray(this.#offset, end), label);
    this.#offset = end + 1;
    return value;
  }

  readBytes(count: number, label: string): Uint8Array {
    this.#require(count, label);
    const value = this.#bytes.subarray(this.#offset, this.#offset + count);
    this.#offset += count;
    return value;
  }

  #require(count: number, label: string): void {
    if (count < 0 || count > this.#bytes.length - this.#offset) {
      throw new Error(`truncated ${label}`);
    }
  }
}

function decodeUtf8Strict(bytes: Uint8Array, label: string): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    // Keep the precise protocol diagnostic off the valid-data hot path. The
    // platform decoder performs the usual validation in native code; this
    // scanner only runs after it has already rejected malformed UTF-8.
    validateUtf8(bytes, label);
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function validateUtf8(bytes: Uint8Array, label: string): void {
  let index = 0;
  while (index < bytes.length) {
    const first = bytes[index]!;
    if (first <= 0x7f) {
      index += 1;
    } else if (first >= 0xc2 && first <= 0xdf) {
      requireContinuation(bytes, index + 1, label);
      index += 2;
    } else if (first === 0xe0) {
      requireRange(bytes, index + 1, 0xa0, 0xbf, label);
      requireContinuation(bytes, index + 2, label);
      index += 3;
    } else if (first >= 0xe1 && first <= 0xec) {
      requireContinuation(bytes, index + 1, label);
      requireContinuation(bytes, index + 2, label);
      index += 3;
    } else if (first === 0xed) {
      requireRange(bytes, index + 1, 0x80, 0x9f, label);
      requireContinuation(bytes, index + 2, label);
      index += 3;
    } else if (first >= 0xee && first <= 0xef) {
      requireContinuation(bytes, index + 1, label);
      requireContinuation(bytes, index + 2, label);
      index += 3;
    } else if (first === 0xf0) {
      requireRange(bytes, index + 1, 0x90, 0xbf, label);
      requireContinuation(bytes, index + 2, label);
      requireContinuation(bytes, index + 3, label);
      index += 4;
    } else if (first >= 0xf1 && first <= 0xf3) {
      requireContinuation(bytes, index + 1, label);
      requireContinuation(bytes, index + 2, label);
      requireContinuation(bytes, index + 3, label);
      index += 4;
    } else if (first === 0xf4) {
      requireRange(bytes, index + 1, 0x80, 0x8f, label);
      requireContinuation(bytes, index + 2, label);
      requireContinuation(bytes, index + 3, label);
      index += 4;
    } else {
      throw invalidUtf8(label, index);
    }
  }
}

function requireContinuation(bytes: Uint8Array, index: number, label: string): void {
  requireRange(bytes, index, 0x80, 0xbf, label);
}

function requireRange(
  bytes: Uint8Array,
  index: number,
  min: number,
  max: number,
  label: string,
): void {
  const byte = bytes[index];
  if (byte === undefined || byte < min || byte > max) {
    throw invalidUtf8(label, index);
  }
}

function invalidUtf8(label: string, index: number): Error {
  return new Error(`${label} is not valid UTF-8 at byte ${index}`);
}

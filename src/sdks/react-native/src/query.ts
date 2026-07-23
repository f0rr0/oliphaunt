import { simpleQuery } from './protocol.js';

export type QueryBinaryInput = ArrayBuffer | ArrayBufferView | Uint8Array | ReadonlyArray<number>;

export type QueryParam =
  | null
  | string
  | number
  | boolean
  | QueryBinaryInput
  | { format: 'text'; value: string | number | boolean }
  | { format: 'binary'; value: QueryBinaryInput };

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

export type QueryRow = {
  values: Array<Uint8Array | null>;
  text(column: number): string | null;
};

export type QueryResult = {
  fields: QueryField[];
  rows: QueryRow[];
  commandTag?: string;
  rowCount: number;
  fieldIndex(name: string): number | undefined;
  getText(row: number, column: string): string | null;
};

export { simpleQuery };

export type PostgresErrorField = {
  code: number;
  value: string;
};

export class PostgresError extends Error {
  readonly severity?: string;
  readonly sqlstate?: string;
  readonly detail?: string;
  readonly hint?: string;
  readonly position?: string;
  readonly whereText?: string;
  readonly schemaName?: string;
  readonly tableName?: string;
  readonly columnName?: string;
  readonly dataTypeName?: string;
  readonly constraintName?: string;
  readonly fields: PostgresErrorField[];
  readonly postgresMessage: string;

  constructor(fields: PostgresErrorField[]) {
    const severity = fieldValue(fields, 0x53) ?? fieldValue(fields, 0x56);
    const sqlstate = fieldValue(fields, 0x43);
    const postgresMessage = fieldValue(fields, 0x4d) ?? 'PostgreSQL ErrorResponse';
    super(formatPostgresError(severity, sqlstate, postgresMessage));
    this.name = 'PostgresError';
    this.severity = severity;
    this.sqlstate = sqlstate;
    this.postgresMessage = postgresMessage;
    this.detail = fieldValue(fields, 0x44);
    this.hint = fieldValue(fields, 0x48);
    this.position = fieldValue(fields, 0x50);
    this.whereText = fieldValue(fields, 0x57);
    this.schemaName = fieldValue(fields, 0x73);
    this.tableName = fieldValue(fields, 0x74);
    this.columnName = fieldValue(fields, 0x63);
    this.dataTypeName = fieldValue(fields, 0x64);
    this.constraintName = fieldValue(fields, 0x6e);
    this.fields = fields;
  }

  static fallback(): PostgresError {
    return new PostgresError([{ code: 0x4d, value: 'PostgreSQL ErrorResponse' }]);
  }
}

export function extendedQuery(sql: string, parameters: ReadonlyArray<QueryParam>): Uint8Array {
  if (parameters.length > 0x7fff) {
    throw new Error(
      `extended query supports at most ${0x7fff} parameters, got ${parameters.length}`,
    );
  }
  if (sql.includes('\0')) {
    throw new Error('extended query SQL must not contain NUL bytes');
  }

  const packet: number[] = [];
  pushParse(packet, sql);
  pushBind(packet, parameters.map(normalizeQueryParam));
  pushDescribePortal(packet);
  pushExecute(packet);
  pushFrontendMessage(packet, 0x53, []);
  return Uint8Array.from(packet);
}

export function parseQueryResponse(bytes: Uint8Array): QueryResult {
  const cursor = new ByteCursor(bytes);
  let fields: QueryField[] | undefined;
  const rows: QueryRow[] = [];
  let commandTag: string | undefined;
  let sawReady = false;

  while (!cursor.isAtEnd()) {
    const tag = cursor.readU8('backend message tag');
    const length = cursor.readI32('backend message length');
    if (length < 4) {
      throw new Error(`invalid backend message length ${length}`);
    }
    const body = new ByteCursor(cursor.readBytes(length - 4, 'backend message body'));

    switch (tag) {
      case 0x54:
        if (fields !== undefined) {
          throw new Error(
            'query() received multiple result sets; use execProtocolRaw for multi-statement row results',
          );
        }
        fields = parseRowDescription(body);
        body.requireEnd('RowDescription');
        break;
      case 0x44:
        if (fields === undefined) {
          throw new Error('DataRow arrived before RowDescription');
        }
        rows.push(parseDataRow(body, fields.length));
        body.requireEnd('DataRow');
        break;
      case 0x43:
        commandTag = body.readCString('CommandComplete tag');
        body.requireEnd('CommandComplete');
        break;
      case 0x45:
        throw parseErrorResponse(body);
      case 0x47:
      case 0x48:
      case 0x57:
      case 0x64:
      case 0x63:
        throw new Error(
          'query() does not support COPY protocol responses; use execProtocolRaw for COPY traffic',
        );
      case 0x5a:
        validateReadyForQuery(body);
        sawReady = true;
        if (!cursor.isAtEnd()) {
          throw new Error('backend returned bytes after ReadyForQuery');
        }
        break;
      case 0x31:
        body.requireEnd('ParseComplete');
        break;
      case 0x32:
        body.requireEnd('BindComplete');
        break;
      case 0x33:
        body.requireEnd('CloseComplete');
        break;
      case 0x49:
        body.requireEnd('EmptyQueryResponse');
        break;
      case 0x6e:
        body.requireEnd('NoData');
        break;
      case 0x53:
        validateParameterStatus(body);
        break;
      case 0x4e:
        validateFieldResponse(body, 'NoticeResponse');
        break;
      case 0x41:
        validateNotificationResponse(body);
        break;
      default:
        throw new Error(`query() received unexpected backend message tag ${hexBackendTag(tag)}`);
    }
  }

  if (!sawReady) {
    throw new Error('query response ended before ReadyForQuery');
  }

  const resultFields = fields ?? [];
  return {
    fields: resultFields,
    rows,
    commandTag,
    rowCount: rows.length,
    fieldIndex(name: string): number | undefined {
      const index = resultFields.findIndex((field) => field.name === name);
      return index >= 0 ? index : undefined;
    },
    getText(row: number, column: string): string | null {
      const columnIndex = this.fieldIndex(column);
      if (columnIndex === undefined) {
        throw new Error(`query result has no column named ${JSON.stringify(column)}`);
      }
      const queryRow = rows[row];
      if (queryRow === undefined) {
        throw new Error(`query result has no row at index ${row}`);
      }
      return queryRow.text(columnIndex);
    },
  };
}

export function assertSuccessfulQueryResponse(bytes: Uint8Array): void {
  const cursor = new ByteCursor(bytes);
  let sawReady = false;

  while (!cursor.isAtEnd()) {
    const tag = cursor.readU8('backend message tag');
    const length = cursor.readI32('backend message length');
    if (length < 4) {
      throw new Error(`invalid backend message length ${length}`);
    }
    const body = new ByteCursor(cursor.readBytes(length - 4, 'backend message body'));

    switch (tag) {
      case 0x45:
        throw parseErrorResponse(body);
      case 0x5a:
        validateReadyForQuery(body);
        sawReady = true;
        if (!cursor.isAtEnd()) {
          throw new Error('backend returned bytes after ReadyForQuery');
        }
        break;
      default:
        break;
    }
  }

  if (!sawReady) {
    throw new Error('query response ended before ReadyForQuery');
  }
}

type NormalizedParam =
  | { kind: 'null' }
  | { kind: 'text'; value: Uint8Array }
  | { kind: 'binary'; value: Uint8Array };

function normalizeQueryParam(parameter: QueryParam): NormalizedParam {
  if (parameter === null) {
    return { kind: 'null' };
  }
  if (
    typeof parameter === 'string' ||
    typeof parameter === 'number' ||
    typeof parameter === 'boolean'
  ) {
    return { kind: 'text', value: new TextEncoder().encode(String(parameter)) };
  }
  if (isQueryBinaryInput(parameter)) {
    return { kind: 'binary', value: toUint8Array(parameter) };
  }
  if (parameter.format === 'text') {
    return { kind: 'text', value: new TextEncoder().encode(String(parameter.value)) };
  }
  return { kind: 'binary', value: toUint8Array(parameter.value) };
}

function isQueryBinaryInput(value: unknown): value is QueryBinaryInput {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value) || Array.isArray(value);
}

function pushParse(out: number[], sql: string): void {
  const body: number[] = [];
  pushCString(body, '');
  pushCString(body, sql);
  pushI16(body, 0);
  pushFrontendMessage(out, 0x50, body);
}

function pushBind(out: number[], parameters: NormalizedParam[]): void {
  const body: number[] = [];
  pushCString(body, '');
  pushCString(body, '');

  pushI16(body, parameters.length);
  for (const parameter of parameters) {
    pushI16(body, parameter.kind === 'binary' ? 1 : 0);
  }

  pushI16(body, parameters.length);
  for (const parameter of parameters) {
    if (parameter.kind === 'null') {
      pushI32(body, -1);
    } else {
      pushSizedValue(body, parameter.value);
    }
  }

  pushI16(body, 1);
  pushI16(body, 0);
  pushFrontendMessage(out, 0x42, body);
}

function pushDescribePortal(out: number[]): void {
  const body: number[] = [0x50];
  pushCString(body, '');
  pushFrontendMessage(out, 0x44, body);
}

function pushExecute(out: number[]): void {
  const body: number[] = [];
  pushCString(body, '');
  pushI32(body, 0);
  pushFrontendMessage(out, 0x45, body);
}

function pushFrontendMessage(out: number[], tag: number, body: ReadonlyArray<number>): void {
  out.push(tag);
  pushI32(out, body.length + 4);
  out.push(...body);
}

function pushCString(out: number[], value: string): void {
  if (value.includes('\0')) {
    throw new Error('frontend protocol string must not contain NUL bytes');
  }
  out.push(...new TextEncoder().encode(value), 0);
}

function pushSizedValue(out: number[], value: Uint8Array): void {
  pushI32(out, value.length);
  out.push(...value);
}

function pushI32(out: number[], value: number): void {
  pushU32(out, value >>> 0);
}

function pushU32(out: number[], value: number): void {
  out.push((value >>> 24) & 0xff);
  out.push((value >>> 16) & 0xff);
  out.push((value >>> 8) & 0xff);
  out.push(value & 0xff);
}

function pushI16(out: number[], value: number): void {
  const bits = value & 0xffff;
  out.push((bits >>> 8) & 0xff);
  out.push(bits & 0xff);
}

export function toUint8Array(input: QueryBinaryInput): Uint8Array {
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

function parseDataRow(cursor: ByteCursor, expectedColumns: number): QueryRow {
  const count = cursor.readI16('DataRow column count');
  if (count < 0) {
    throw new Error(`invalid DataRow column count ${count}`);
  }
  if (count !== expectedColumns) {
    throw new Error(
      `DataRow column count ${count} does not match RowDescription count ${expectedColumns}`,
    );
  }
  const values: Array<Uint8Array | null> = [];
  for (let index = 0; index < count; index += 1) {
    const length = cursor.readI32('DataRow value length');
    if (length === -1) {
      values.push(null);
    } else if (length < 0) {
      throw new Error(`invalid DataRow value length ${length}`);
    } else {
      values.push(cursor.readBytes(length, 'DataRow value'));
    }
  }
  return {
    values,
    text(column: number): string | null {
      if (column < 0 || column >= values.length) {
        throw new Error(`query row has no column at index ${column}`);
      }
      const value = values[column]!;
      return value === null ? null : decodeUtf8Strict(value, 'query value');
    },
  };
}

function parseErrorResponse(cursor: ByteCursor): PostgresError {
  const fields: PostgresErrorField[] = [];
  while (!cursor.isAtEnd()) {
    let code: number;
    try {
      code = cursor.readU8('ErrorResponse field code');
    } catch {
      return PostgresError.fallback();
    }
    if (code === 0) {
      break;
    }
    let value: string;
    try {
      value = cursor.readCString('ErrorResponse field');
    } catch {
      return PostgresError.fallback();
    }
    fields.push({ code, value });
  }
  return new PostgresError(fields);
}

function fieldValue(fields: ReadonlyArray<PostgresErrorField>, code: number): string | undefined {
  return fields.find((field) => field.code === code)?.value;
}

function formatPostgresError(
  severity: string | undefined,
  sqlstate: string | undefined,
  message: string,
): string {
  if (severity !== undefined && sqlstate !== undefined) {
    return `${severity} [${sqlstate}]: ${message}`;
  }
  if (severity !== undefined) {
    return `${severity}: ${message}`;
  }
  if (sqlstate !== undefined) {
    return `[${sqlstate}]: ${message}`;
  }
  return message;
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

function validateReadyForQuery(body: ByteCursor): void {
  const remaining = body.remainingBytes();
  if (remaining !== 1) {
    throw new Error(`ReadyForQuery contained ${remaining} bytes, expected 1`);
  }
  const status = body.readU8('ReadyForQuery transaction status');
  if (status !== 0x49 && status !== 0x54 && status !== 0x45) {
    throw new Error(`ReadyForQuery contained invalid transaction status ${hexBackendTag(status)}`);
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

function validateFieldResponse(body: ByteCursor, label: string): void {
  for (;;) {
    if (body.isAtEnd()) {
      throw new Error(`${label} is missing terminator`);
    }
    const code = body.readU8(`${label} field code`);
    if (code === 0) {
      body.requireEnd(label);
      return;
    }
    body.readCString(`${label} field`);
  }
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

  requireEnd(label: string): void {
    if (!this.isAtEnd()) {
      throw new Error(`${label} contained trailing bytes`);
    }
  }

  readU8(label: string): number {
    return this.readBytes(1, label)[0]!;
  }

  readU32(label: string): number {
    return (
      (this.readU8(label) * 0x1000000 +
        (this.readU8(label) << 16) +
        (this.readU8(label) << 8) +
        this.readU8(label)) >>>
      0
    );
  }

  readI32(label: string): number {
    const value = this.readU32(label);
    return value > 0x7fffffff ? value - 0x100000000 : value;
  }

  readI16(label: string): number {
    const value = (this.readU8(label) << 8) | this.readU8(label);
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
    if (count < 0 || this.#offset + count > this.#bytes.length) {
      throw new Error(`truncated ${label}`);
    }
    const value = this.#bytes.slice(this.#offset, this.#offset + count);
    this.#offset += count;
    return value;
  }
}

function decodeUtf8Strict(bytes: Uint8Array, label: string): string {
  validateUtf8(bytes, label);
  return new TextDecoder().decode(bytes);
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

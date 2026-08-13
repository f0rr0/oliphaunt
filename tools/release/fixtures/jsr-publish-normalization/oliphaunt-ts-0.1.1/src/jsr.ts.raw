export { simpleQuery } from './protocol.js';
export {
  assertSuccessfulQueryResponse,
  extendedQuery,
  parseQueryResponse,
  PostgresError,
  toUint8Array,
  type PostgresErrorField,
  type QueryBinaryInput,
  type QueryField,
  type QueryFormat,
  type QueryParam,
  type QueryResult,
  type QueryRow,
} from './query.js';

function nativeUnavailable(): never {
  throw new Error(
    'Native Oliphaunt runtimes are not available from jsr:@oliphaunt/ts; import from npm:@oliphaunt/ts for Node, Bun, or Deno native runtime support.',
  );
}

export type JsrOliphauntClient = {
  supportedModes(): Promise<[]>;
  open(): Promise<never>;
  restore(): Promise<never>;
};

export const Oliphaunt: JsrOliphauntClient = {
  async supportedModes(): Promise<[]> {
    return [];
  },
  async open(): Promise<never> {
    nativeUnavailable();
  },
  async restore(): Promise<never> {
    nativeUnavailable();
  },
};

export default Oliphaunt;

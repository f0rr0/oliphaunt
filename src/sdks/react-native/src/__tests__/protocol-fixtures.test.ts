import { test } from 'vitest';

import { assertSharedProtocolFixtures } from '../../../../shared/js-core/test/protocol-fixtures.mjs';
import { parseQueryRawResponse, parseSimpleQueryRawResponse, PostgresError } from '../query';

test('protocol fixtures', () => {
  assertSharedProtocolFixtures({
    parseSimpleQueryResponse: parseSimpleQueryRawResponse,
    parseExtendedQueryResponse: parseQueryRawResponse,
    isPostgresError: (error): error is PostgresError => error instanceof PostgresError,
  });
});

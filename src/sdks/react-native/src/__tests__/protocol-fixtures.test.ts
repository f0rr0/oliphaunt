import { test } from 'vitest';

import { assertSharedProtocolFixtures } from '../../../../shared/js-core/test/protocol-fixtures.mjs';
import { parseQueryResponse, PostgresError } from '../query';

test('protocol fixtures', () => {
  assertSharedProtocolFixtures({
    parseQueryResponse,
    isPostgresError: (error): error is PostgresError => error instanceof PostgresError,
  });
});

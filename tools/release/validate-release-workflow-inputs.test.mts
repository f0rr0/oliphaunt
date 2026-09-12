import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dir, '../..');
test('both npm publication jobs can generate required provenance', () => {
  const workflow = Bun.YAML.parse(
    readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8'),
  );
  for (const job of ['publish', 'publish-bootstrap']) {
    assert.equal(
      workflow.jobs[job].permissions['id-token'],
      'write',
      `${job} requires OIDC for npm --provenance even with token authentication`,
    );
  }
});

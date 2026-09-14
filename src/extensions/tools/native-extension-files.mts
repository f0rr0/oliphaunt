#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Shell builders need only the installed file identities, not a compiled SDK.
const { extensions } = JSON.parse(
  readFileSync(new URL('../generated/sdk/extensions.json', import.meta.url), 'utf8'),
);
const rows = extensions.map((extension) => {
  const name = extension['sql-name'];
  const stem = extension['native-module-stem'];
  const data = extension['runtime-share-data-files'];
  assert(typeof name === 'string' && /^[a-z0-9_-]+$/.test(name));
  assert(stem === null || (typeof stem === 'string' && /^[a-z0-9_-]+$/.test(stem)));
  assert(Array.isArray(data));
  for (const member of data)
    assert(
      typeof member === 'string' &&
        member
          .split('/')
          .every((part) => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== '.' && part !== '..'),
    );
  return [name, stem ?? '-', data.join(',') || '-'].join('\t');
});
console.log(['sql_name\tnative_module_stem\tdata_files', ...rows].join('\n'));

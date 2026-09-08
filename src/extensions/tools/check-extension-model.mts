#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  catalogProjections,
  discoverCatalog,
  extensionProjections,
  jsonText,
  readJson,
} from './extension-projections.mts';
import {
  currentEvidenceTable,
  evidenceMatrix,
  evidenceMatrixPath,
  evidenceRunsPath,
  evidenceTablePath,
  recordedEvidence,
  sourceDigestInputs,
} from './extension-evidence.mts';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    stage: { type: 'string' },
    'release-metadata': { type: 'string' },
    'source-inputs': { type: 'boolean' },
    'source-commit': { type: 'string' },
    'source-tree': { type: 'string' },
    'clean-inputs': { type: 'boolean' },
    write: { type: 'boolean' },
    check: { type: 'boolean' },
    'write-evidence': { type: 'boolean' },
    'write-evidence-summary': { type: 'boolean' },
    'require-current-evidence': { type: 'boolean' },
    'record-wasix-evidence-run': { type: 'string' },
    'observed-at': { type: 'string' },
  },
  strict: true,
});
if (values['source-inputs']) {
  console.log(sourceDigestInputs().join('\n'));
} else {
  assert(
    values.stage && values['release-metadata'],
    'run bash src/extensions/tools/check-extension-model.sh',
  );
  assert(
    [
      values.write,
      values['write-evidence'],
      values['write-evidence-summary'],
      values['record-wasix-evidence-run'],
    ].filter(Boolean).length <= 1,
    'mutation modes are mutually exclusive',
  );
  const identity = { commit: values['source-commit'] ?? '', tree: values['source-tree'] ?? '' };
  assert(
    /^[0-9a-f]{40}$/.test(identity.commit) && /^[0-9a-f]{40}$/.test(identity.tree),
    'missing checkout commit/tree',
  );
  const catalog = discoverCatalog();
  const outputs = new Map([
    ...catalogProjections(catalog),
    ...extensionProjections(catalog, readJson(values['release-metadata']) as any),
  ]);
  if (values.write || values['write-evidence'] || values['record-wasix-evidence-run'])
    outputs.set(evidenceMatrixPath, evidenceMatrix(catalog));
  const matrix = outputs.has(evidenceMatrixPath)
    ? Bun.TOML.parse(outputs.get(evidenceMatrixPath)!)
    : undefined;
  const extraRuns = [];
  if (values['record-wasix-evidence-run']) {
    assert(values['observed-at'], 'recording requires --observed-at');
    const file = `${evidenceRunsPath}/${values['record-wasix-evidence-run']}.json`;
    const run = recordedEvidence(
      catalog,
      values['record-wasix-evidence-run'],
      values['observed-at'],
      identity,
      values['clean-inputs'] ?? false,
    );
    outputs.set(file, jsonText(run));
    extraRuns.push({ path: file, run });
  } else assert(!values['observed-at'], '--observed-at requires recording');
  outputs.set(
    evidenceTablePath,
    currentEvidenceTable(
      catalog,
      identity,
      values['require-current-evidence'],
      matrix,
      outputs,
      extraRuns,
    ),
  );
  for (const [file, text] of outputs) {
    const destination = path.join(values.stage, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, text);
    console.log(file);
  }
}

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { affectedInputs, taskRoots } from './ci-plan-test-inputs.mts';

function key(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function observation(kind, input) {
  const directory = process.env.OLIPHAUNT_CI_TEST_OBSERVATIONS;
  if (!directory) throw new Error('run through tools/ci/check-workflows.sh');
  return JSON.parse(readFileSync(path.join(directory, `${kind}-${key(input)}.json`), 'utf8'));
}
export function affectedObservation(input) {
  return observation('affected', Array.isArray(input) ? input : [input]);
}
export function taskObservation(target) {
  return Object.values(observation('task', target).data);
}

if (import.meta.main) {
  const directory = process.argv[2];
  if (!directory) throw new Error('expected observation directory');
  mkdirSync(directory, { recursive: true });
  const requests = [];
  for (const input of affectedInputs) {
    const id = key(input);
    writeFileSync(path.join(directory, `affected-${id}.input`), input.join('\n') + '\n');
    requests.push(`affected\t${id}`);
  }
  for (const target of Object.values(taskRoots)) requests.push(`task\t${key(target)}\t${target}`);
  writeFileSync(path.join(directory, 'requests.tsv'), requests.join('\n') + '\n');
}

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runWorkflowLinters } from './workflow-lint.mts';

const tools = process.argv.slice(2);
assert.equal(tools.length, 3, 'Expected actual declared workflow linter tools');
{
  const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'workflow-lint-'));
  try {
    mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
    mkdirSync(path.join(root, '.github/actions'), { recursive: true });
    writeFileSync(path.join(root, '.github/zizmor.yml'), 'rules: {}\n');
    const safe =
      'name: Fixture\non: pull_request\npermissions:\n  contents: read\njobs:\n  verify:\n    runs-on: ubuntu-24.04\n    steps:\n      - name: Exercise shell\n        run: printf "%s\\n" safe\n';
    const file = path.join(root, '.github/workflows/fixture.yml');
    for (const [source, valid] of [
      [safe, true],
      [safe.replace('contents: read', 'contents: write'), false],
      [safe.replace('runs-on: ubuntu-24.04', 'needs: missing\n    runs-on: ubuntu-24.04'), false],
      [
        safe.replace(
          'printf "%s\\n" safe',
          'echo ' + '$' + '{{ github.event.pull_request.title }}',
        ),
        false,
      ],
      [safe.replace('printf "%s\\n" safe', 'echo $MISSING_SHELL_VARIABLE'), false],
    ] as const) {
      writeFileSync(file, source);
      const result = runWorkflowLinters(root, tools, true);
      assert.equal(result.status === 0, valid, result.stderr + result.stdout);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

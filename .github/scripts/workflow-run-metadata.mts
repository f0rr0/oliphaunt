import * as fs from 'node:fs';

const [command, ...args] = Bun.argv.slice(2);
switch (command) {
  case 'run-row': {
    const run = await Bun.stdin.json();
    if (
      !/^[0-9A-Fa-f]{40}$/u.test(run.head_sha ?? '') ||
      !Number.isSafeInteger(run.workflow_id) ||
      run.workflow_id <= 0 ||
      !Number.isSafeInteger(run.run_attempt) ||
      run.run_attempt <= 0 ||
      [run.event, run.status, run.conclusion ?? ''].some(
        (value) => typeof value !== 'string' || /[^a-z_]/u.test(value),
      )
    )
      throw new Error('malformed workflow run metadata');
    console.log(
      [
        run.head_sha,
        run.workflow_id,
        run.event,
        run.status,
        run.conclusion ?? '',
        run.run_attempt,
      ].join('\t'),
    );
    break;
  }
  case 'workflow-name': {
    const workflow = await Bun.stdin.json();
    if (
      typeof workflow.name !== 'string' ||
      !workflow.name ||
      /[\u0000-\u001f\u007f]/u.test(workflow.name)
    )
      throw new Error('malformed workflow name');
    console.log(workflow.name);
    break;
  }
  case 'artifact-ids': {
    console.log(
      'artifact_ids=' +
        JSON.parse(process.env.ARTIFACTS_JSON)
          .map((row) => row.id)
          .join(','),
    );
    break;
  }
  case 'names': {
    const names = (await Bun.stdin.text()).split(/\r?\n/u).filter(Boolean);
    process.stdout.write(JSON.stringify(names));
    break;
  }
  case 'select-artifacts': {
    const expected = JSON.parse(process.env.REQUIRED_ARTIFACTS_JSON);
    const gates = JSON.parse(process.env.GATE_ARTIFACTS_JSON);
    let records;
    try {
      records = JSON.parse(await Bun.stdin.text());
    } catch (cause) {
      console.error(`artifact inventory is not valid JSON: ${cause.message}`);
      process.exit(64);
    }
    if (
      !Array.isArray(expected) ||
      !Array.isArray(gates) ||
      expected.length + gates.length === 0 ||
      [...expected, ...gates].some((name) => typeof name !== 'string' || name.length === 0) ||
      new Set([...expected, ...gates]).size !== expected.length + gates.length
    ) {
      console.error('required artifact identity list is malformed');
      process.exit(64);
    }
    if (
      !Array.isArray(records) ||
      records.some(
        (entry) =>
          entry === null ||
          Array.isArray(entry) ||
          typeof entry !== 'object' ||
          typeof entry.name !== 'string' ||
          typeof entry.expired !== 'boolean' ||
          !Number.isSafeInteger(entry.id) ||
          entry.id < 1 ||
          !Number.isSafeInteger(entry.size_in_bytes) ||
          entry.size_in_bytes < 1 ||
          typeof entry.digest !== 'string' ||
          !/^sha256:[0-9a-f]{64}$/u.test(entry.digest),
      )
    ) {
      console.error('artifact inventory contains malformed metadata');
      process.exit(64);
    }
    const selected = [];
    const selectedGates = [];
    for (const name of [...expected, ...gates]) {
      const matches = records.filter((entry) => entry.name === name && entry.expired === false);
      if (matches.length !== 1) {
        console.error(
          `expected exactly one non-expired artifact named ${name}; found ${matches.length}`,
        );
        process.exit(1);
      }
      const [entry] = matches;
      const record = {
        digest: entry.digest,
        id: entry.id,
        name: entry.name,
        size: entry.size_in_bytes,
      };
      (expected.includes(name) ? selected : selectedGates).push(record);
    }
    selected.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    selectedGates.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    process.stdout.write(JSON.stringify({ selected, selectedGates }));
    break;
  }
  case 'selected-artifacts': {
    const value = JSON.parse(process.env.SELECTION_JSON);
    process.stdout.write(JSON.stringify(value.selected));
    break;
  }
  case 'selected-gates': {
    const value = JSON.parse(process.env.SELECTION_JSON);
    process.stdout.write(JSON.stringify(value.selectedGates));
    break;
  }
  case 'jobs': {
    const data = JSON.parse(fs.readFileSync(args[0], 'utf8'));
    const required = args.slice(1);
    if (!Array.isArray(data)) {
      console.error('workflow job inventory must be a list');
      process.exit(1);
    }
    const failures = required
      .map((name) => {
        const matches = data.filter((job) => job?.name === name);
        if (matches.length !== 1) return [name, `count-${matches.length}`];
        return [name, matches[0]?.conclusion ?? 'missing'];
      })
      .filter(([, conclusion]) => conclusion !== 'success');
    if (failures.length > 0) {
      console.error(failures.map(([name, conclusion]) => `${name}=${conclusion}`).join(', '));
      process.exit(1);
    }
    break;
  }
  case 'workflow-id': {
    const expected = process.env.WORKFLOW_NAME;
    let rows;
    try {
      rows = JSON.parse(await Bun.stdin.text());
    } catch (cause) {
      console.error(`workflow inventory is not valid JSON: ${cause.message}`);
      process.exit(1);
    }
    if (!Array.isArray(rows)) {
      console.error('workflow inventory must be a list');
      process.exit(1);
    }
    const matches = rows.filter((row) => row?.name === expected);
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0]?.id) || matches[0].id < 1) {
      console.error(`expected exactly one workflow named ${expected}; found ${matches.length}`);
      process.exit(1);
    }
    process.stdout.write(String(matches[0].id));
    break;
  }
  case 'runs': {
    const expectedSha = process.env.EXPECTED_SHA;
    let rows;
    try {
      rows = JSON.parse(await Bun.stdin.text());
    } catch (cause) {
      console.error(`workflow run inventory is not valid JSON: ${cause.message}`);
      process.exit(1);
    }
    if (!Array.isArray(rows)) {
      console.error('workflow run inventory must be a list');
      process.exit(1);
    }
    const ids = new Set();
    const rendered = [];
    for (const row of rows) {
      const conclusion = row?.conclusion ?? '';
      if (
        row === null ||
        Array.isArray(row) ||
        typeof row !== 'object' ||
        !Number.isSafeInteger(row.id) ||
        row.id < 1 ||
        ids.has(row.id) ||
        typeof row.head_sha !== 'string' ||
        row.head_sha.toLowerCase() !== expectedSha ||
        typeof row.status !== 'string' ||
        typeof conclusion !== 'string' ||
        typeof row.html_url !== 'string' ||
        /[\t\r\n]/u.test(row.html_url) ||
        typeof row.event !== 'string' ||
        /[\t\r\n]/u.test(row.event)
      ) {
        console.error(
          'workflow run inventory contains malformed, duplicate, or non-exact-SHA metadata',
        );
        process.exit(1);
      }
      ids.add(row.id);
      rendered.push([row.id, row.status, conclusion, row.html_url, row.event].join('\t'));
    }
    process.stdout.write(rendered.join('\n'));
    break;
  }
  default:
    throw new Error('unknown workflow metadata command: ' + command);
}

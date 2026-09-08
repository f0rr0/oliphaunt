#!/usr/bin/env bun
// Exercises carrier argument validation and failure cleanup without executing Wasm.
import assert from 'node:assert/strict';
import {
  accessSync,
  appendFileSync,
  constants,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === 'run') {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const volumes: string[] = [];
  const valueOptions = ['--stack-size', '--sealed-module-manifest'];
  const flagOptions = [
    '--disable-cache',
    '--enable-exceptions',
    '--enable-threads',
    '--net',
    '--quiet',
  ];
  let modulePath = '';
  let guestArgs: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      guestArgs = args.slice(i + 1);
      break;
    }
    if (arg === '--volume' || valueOptions.includes(arg)) {
      assert(args[i + 1], `${arg} has no value`);
      if (arg === '--volume') volumes.push(args[++i]);
      else {
        assert(!values.has(arg), `duplicate option ${arg}`);
        values.set(arg, args[++i]);
      }
    } else if (flagOptions.includes(arg)) {
      assert(!flags.has(arg), `duplicate option ${arg}`);
      flags.add(arg);
    } else {
      assert(!arg.startsWith('-') && !modulePath, `unknown argument ${arg}`);
      modulePath = arg;
    }
  }
  assert(
    modulePath && flagOptions.slice(0, 4).every((flag) => flags.has(flag)),
    'run lacks module or required flags',
  );
  const manifestPath = values.get('--sealed-module-manifest');
  assert(manifestPath, 'run did not receive a sealed manifest');
  const root = dirname(realpathSync(manifestPath));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert(
    manifest['format-version'] === 6 &&
      manifest.schema === 'oliphaunt.wasix-postmaster.sealed-aot.v5',
    'expected final manifest',
  );
  assert(
    manifest.artifacts.every((artifact: object) => !('preinitialized-memory' in artifact)),
    'final artifact has a memory image',
  );
  function volume(guest: string) {
    const matches = volumes.filter((value) => value.slice(value.lastIndexOf(':') + 1) === guest);
    assert(matches.length === 1, `expected one volume at ${guest}`);
    return matches[0].slice(0, matches[0].lastIndexOf(':'));
  }
  for (const [guest, host] of [
    ['/lib', join(root, 'lib')],
    ['/share', join(root, 'share')],
    [root, root],
  ]) {
    assert.equal(volume(guest), host, `incorrect mount at ${guest}`);
  }
  const program = basename(modulePath);
  assert.equal(
    realpathSync(modulePath),
    join(root, 'bin', program),
    'module is outside staged carrier',
  );
  if (process.env.FAKE_WASMER_VALIDATION_LOG) {
    appendFileSync(
      process.env.FAKE_WASMER_VALIDATION_LOG,
      `${JSON.stringify({ program, arguments: guestArgs, volumes })}\n`,
    );
  }
  if (program === 'postgres') assert.deepEqual(guestArgs, ['--version']);
  else {
    assert.equal(program, 'initdb');
    assert.deepEqual(guestArgs, [
      '-D',
      '/pgdata',
      '-A',
      'trust',
      '--no-locale',
      '--encoding=UTF8',
      '--no-instructions',
    ]);
    const data = realpathSync(volume('/pgdata'));
    for (const dir of [data, realpathSync(volume('/dev/shm'))]) {
      assert(statSync(dir).isDirectory());
      accessSync(dir, constants.W_OK);
      assert(relative(root, dir).startsWith('../'), 'writable directory overlaps staged carrier');
    }
    assert(
      process.env.FAKE_WASMER_FAIL_FINAL_INITDB !== '1',
      'requested final initdb lifecycle failure',
    );
    if (process.env.FAKE_WASMER_SKIP_INITDB_OUTPUT !== '1') {
      mkdirSync(join(data, 'global'));
      writeFileSync(join(data, 'PG_VERSION'), '18\n');
      writeFileSync(join(data, 'global/pg_control'), 'fake-pg-control\n');
    }
  }
}

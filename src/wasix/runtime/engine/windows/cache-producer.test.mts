import { expect, test } from 'bun:test';
import { runCacheProducer } from './cache-producer.mts';

function run(script: string, timeoutMs = 1_000) {
  return runCacheProducer([process.execPath, '-e', script], { cwd: process.cwd(), timeoutMs });
}

test('supervises a fragmented completion after cleanup', async () => {
  const log = await run(`
    console.log('stage=emulated_producer_completed');
    process.stdout.write('producer_ex');
    setTimeout(() => process.stdout.write('it=0\\n'), 10);
    setInterval(() => {}, 1000);
  `);
  expect(log).toContain('stage=emulated_producer_completed\nproducer_exit=0\n');
});

test('does not turn native cache rejection into success', async () => {
  await expect(
    run("console.log('native_deserialize=REJECT\\nproducer_exit=24'); setInterval(() => {}, 1000)"),
  ).rejects.toThrow('native_deserialize=REJECT');
});

test('does not accept a success log followed by an unsupervised crash', async () => {
  await expect(
    run("console.log('native_deserialize=PASS'); process.kill(process.pid, 'SIGKILL')"),
  ).rejects.toThrow('before supervised completion');
});

test('requires an entire completion line', async () => {
  await expect(run("process.stdout.write('producer_exit=0')")).rejects.toThrow(
    'before supervised completion',
  );
});

test('bounds a stalled helper', async () => {
  await expect(run('setInterval(() => {}, 1000)', 100)).rejects.toThrow('timed out');
});

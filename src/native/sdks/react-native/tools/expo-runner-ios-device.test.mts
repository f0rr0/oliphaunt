import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const tool = fileURLToPath(new URL('./expo-runner-ios-device.mts', import.meta.url));
const devices = {
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [
      { isAvailable: true, name: 'iPhone 17 Pro', state: 'Booted', udid: 'current' },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-17-4': [
      { isAvailable: true, name: 'iPhone 15 Pro', state: 'Booted', udid: 'floor' },
    ],
  },
};

function select(command, environment) {
  return spawnSync(process.execPath, [tool, command], {
    env: {
      ...process.env,
      OLIPHAUNT_EXPO_IOS_DEVICE_NAME: '',
      OLIPHAUNT_EXPO_IOS_SIMULATOR_RUNTIME: '',
      ...environment,
    },
    input: JSON.stringify(devices),
  });
}

test('an explicit iOS runtime constrains booted and available simulator selection', () => {
  const environment = { OLIPHAUNT_EXPO_IOS_SIMULATOR_RUNTIME: 'iOS-17-4' };
  for (const command of ['booted-simulator', 'available-simulator']) {
    const result = select(command, environment);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.toString(), 'floor');
  }
});

test('an unavailable explicit iOS runtime fails instead of silently using another runtime', () => {
  const result = select('available-simulator', {
    OLIPHAUNT_EXPO_IOS_SIMULATOR_RUNTIME: 'iOS-18-0',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr.toString(), /runtime=iOS-18-0/u);
});

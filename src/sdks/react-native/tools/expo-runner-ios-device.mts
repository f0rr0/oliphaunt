import * as fs from 'node:fs';

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'physical-device': {
    const file = args[0];
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const devices = data?.result?.devices ?? [];
    const candidates = devices.filter((device) => {
      const hardware = device.hardwareProperties ?? {};
      const connection = device.connectionProperties ?? {};
      return (
        hardware.platform === 'iOS' &&
        hardware.reality === 'physical' &&
        connection.pairingState === 'paired'
      );
    });
    candidates.sort((left, right) => {
      const leftLocal = left.connectionProperties?.transportType === 'localNetwork' ? 1 : 0;
      const rightLocal = right.connectionProperties?.transportType === 'localNetwork' ? 1 : 0;
      const leftName = String(left.deviceProperties?.name ?? '');
      const rightName = String(right.deviceProperties?.name ?? '');
      return rightLocal - leftLocal || (leftName < rightName ? -1 : leftName > rightName ? 1 : 0);
    });
    if (!candidates.length) {
      process.exit(1);
    }
    process.stdout.write(candidates[0].identifier || candidates[0].hardwareProperties?.udid);
    break;
  }
  case 'preflight': {
    const file = args[0];
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const result = data.result ?? {};
    const props = result.deviceProperties ?? {};
    const hardware = result.hardwareProperties ?? {};
    const name = props.name ?? 'physical iOS device';
    const os = props.osVersionNumber ?? 'unknown iOS';
    const devMode = props.developerModeStatus ?? 'unknown';
    if (devMode !== 'enabled') {
      console.error(
        `error: physical iOS runs require Developer Mode enabled on ${name}; current developerModeStatus=${devMode}, os=${os}`,
      );
      process.exit(1);
    }
    if (props.ddiServicesAvailable === false) {
      const product = hardware.productType ?? 'unknown product';
      console.error(
        `error: physical iOS runs require Developer Disk Image services on ${name}; ddiServicesAvailable=false, product=${product}, os=${os}`,
      );
      process.exit(1);
    }
    break;
  }
  case 'booted-simulator': {
    const data = JSON.parse(fs.readFileSync(0, 'utf8'));
    for (const devices of Object.values(data.devices || {})) {
      const found = devices.find((device) => device.isAvailable && device.state === 'Booted');
      if (found) {
        process.stdout.write(found.udid);
        process.exit(0);
      }
    }

    break;
  }
  case 'available-simulator': {
    const preferredName = process.env.OLIPHAUNT_EXPO_IOS_DEVICE_NAME || 'iPhone 15 Pro';
    const preferredRuntime = process.env.OLIPHAUNT_EXPO_IOS_RUNTIME || '';
    const data = JSON.parse(fs.readFileSync(0, 'utf8'));
    const candidates = [];
    for (const [runtime, devices] of Object.entries(data.devices || {})) {
      if (!runtime.includes('iOS')) {
        continue;
      }
      const versionMatch = runtime.match(/iOS-(\d+)-(\d+)/);
      const major = versionMatch ? Number(versionMatch[1]) : 0;
      const minor = versionMatch ? Number(versionMatch[2]) : 0;
      for (const device of devices) {
        if (!device.isAvailable) {
          continue;
        }
        const exactName = device.name === preferredName ? 1 : 0;
        const iphone = device.name.startsWith('iPhone') ? 1 : 0;
        const runtimeMatch = preferredRuntime && runtime.includes(preferredRuntime) ? 1 : 0;
        candidates.push({ device, exactName, iphone, runtimeMatch, major, minor });
      }
    }
    candidates.sort(
      (left, right) =>
        right.runtimeMatch - left.runtimeMatch ||
        right.exactName - left.exactName ||
        right.iphone - left.iphone ||
        right.major - left.major ||
        right.minor - left.minor ||
        (left.device.name < right.device.name ? -1 : left.device.name > right.device.name ? 1 : 0),
    );
    if (!candidates.length) {
      process.exit(1);
    }
    process.stdout.write(candidates[0].device.udid);

    break;
  }
  case 'process-id': {
    const data = JSON.parse(fs.readFileSync(args[0], 'utf8'));
    const seen = new Set();
    function visit(value) {
      if (value == null || typeof value !== 'object' || seen.has(value)) {
        return undefined;
      }
      seen.add(value);
      for (const key of ['processIdentifier', 'pid']) {
        if (Number.isInteger(value[key]) && value[key] > 0) {
          return value[key];
        }
      }
      for (const child of Object.values(value)) {
        const found = visit(child);
        if (found !== undefined) {
          return found;
        }
      }
      return undefined;
    }
    const pid = visit(data);
    if (!pid) {
      process.exit(1);
    }
    process.stdout.write(String(pid));
    break;
  }
  default:
    throw new Error('unknown expo-runner-ios-device command: ' + command);
}

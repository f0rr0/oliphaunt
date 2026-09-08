import { readFileSync, writeFileSync } from 'node:fs';
import { tarArchive } from '../../../../../../../tools/test/tar-fixture.mts';

const [kind, destination, driverPath] = process.argv.slice(2);
const driver = { name: 'wasixccenv', mode: 0o755, data: readFileSync(driverPath) };
const malicious = {
  traversal: { name: '../escaped', data: 'fixture' },
  duplicate: driver,
  symlink: { name: 'escape-symlink', type: '2', linkTarget: '/etc/passwd' },
  hardlink: { name: 'escape-hardlink', type: '1', linkTarget: '../outside' },
  device: { name: 'device', type: '3' },
}[kind];
if (!malicious) throw new Error(`unknown malicious archive kind: ${kind}`);
writeFileSync(destination, tarArchive([driver, malicious]));

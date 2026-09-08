import { readFileSync } from 'node:fs';

const [field, file] = process.argv.slice(2);
const value =
  field === 'package-version'
    ? JSON.parse(readFileSync(file, 'utf8')).version
    : { executable: process.execPath, platform: process.platform, arch: process.arch }[field];
if (typeof value !== 'string' || value.length === 0) throw new Error(`missing Node info: ${field}`);
process.stdout.write(value);

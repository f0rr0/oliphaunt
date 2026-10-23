import { readFileSync, writeFileSync } from 'node:fs';

const [output, input] = process.argv.slice(2);
const value = readFileSync(input, 'utf8').trim();
if (!/^-?\d+$/.test(value)) throw new Error('fixture configuration must be an integer');
writeFileSync(output, `#define CONFIG_VALUE ${value}\n`);

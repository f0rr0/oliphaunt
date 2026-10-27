import { readFileSync, writeFileSync } from 'node:fs';
import { decorate } from './native-entry-helper.mts';

const [source, output] = process.argv.slice(2);
if (!source || !output || process.argv.length !== 4) {
  throw new Error('native entry generator requires exactly source and output');
}
writeFileSync(output, JSON.stringify({ value: decorate(readFileSync(source, 'utf8')) }));

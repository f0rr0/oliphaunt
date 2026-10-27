import { readFileSync, writeFileSync } from 'node:fs';

const [output, binary, legal, version, product] = process.argv.slice(2);
if (!/^\d+[.]\d+[.]\d+$/.test(version)) throw new Error('invalid fixture version');
writeFileSync(output, JSON.stringify({
  executable: readFileSync(binary).toString('base64'),
  legal: readFileSync(legal, 'utf8'),
  version,
  product,
}) + '\n');

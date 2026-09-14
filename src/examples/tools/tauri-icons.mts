import * as fs from 'node:fs';
import * as path from 'node:path';

const [configFile, root] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const icons = config?.bundle?.icon ?? [];
if (!Array.isArray(icons) || !icons.every((value) => typeof value === 'string')) {
  throw new Error(`${configFile}: bundle.icon must be an array of paths`);
}
for (const icon of icons) {
  const source = path.resolve(path.dirname(configFile), icon);
  const relative = path.relative(root, source);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${configFile}: bundle icon escapes the repository: ${icon}`);
  }
  if (/[\r\n\0]/u.test(relative)) {
    throw new Error(`${configFile}: bundle icon has an unsafe path: ${icon}`);
  }
  if (!fs.statSync(source).isFile()) {
    throw new Error(`${configFile}: bundle icon is not a regular file: ${icon}`);
  }
  process.stdout.write(`${relative.split(path.sep).join('/')}\n`);
}

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
try {
  if (!lstatSync(root).isDirectory()) throw new Error('payload must be a real directory');
  const files = [];
  let expanded = 0;
  let count = 0;
  function walk(relative = '') {
    for (const name of readdirSync(path.join(root, relative))) {
      const member = relative ? `${relative}/${name}` : name;
      if (++count > 512 || /[\x00-\x1f\x7f]/u.test(member))
        throw new Error('invalid payload inventory');
      const file = path.join(root, member);
      const stat = lstatSync(file);
      if (stat.isDirectory()) {
        walk(member);
        continue;
      }
      if (!stat.isFile()) throw new Error(`payload contains a link or special file: ${member}`);
      expanded += stat.size;
      if (expanded > 10_000_000) throw new Error('payload exceeds its byte bound');
      files.push({ member, file, size: stat.size });
    }
  }
  walk();
  files.sort((a, b) => Buffer.compare(Buffer.from(a.member), Buffer.from(b.member)));
  const digest = createHash('sha256');
  for (const { member, file, size } of files) {
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
    digest.update(`${member}\0${size}\0${hash}\n`);
  }
  console.log(`${digest.digest('hex')}\t${files.length}\t${expanded}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

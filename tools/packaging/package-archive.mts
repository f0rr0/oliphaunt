/** Exact deterministic source/package tar framing shared by bounded envelope actions. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { tarHeader } from './archive-directory.mts';

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function abort(fail, message) {
  if (typeof fail === 'function') fail(message);
  throw new Error(message);
}

export function listArchiveEntries(directory) {
  const files = [];
  const entries = readdirSync(directory, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(fullPath, ...listArchiveEntries(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    } else {
      throw new Error(
        `Cargo archive source must contain only regular files and directories: ${fullPath}`,
      );
    }
  }
  return files;
}

export function createDeterministicTar(stageDir, packageRoot, options) {
  const chunks = [];
  const fixedFileMode = options.fixedFileMode;
  const executableFiles = options.executableFiles ?? new Set();
  if (
    fixedFileMode !== undefined &&
    (!Number.isInteger(fixedFileMode) || fixedFileMode < 0 || fixedFileMode > 0o777)
  ) {
    abort(
      options.fail,
      'fixed deterministic tar file mode must be an integer between 0000 and 0777',
    );
  }
  const files = listArchiveEntries(stageDir).filter(
    (file) => options.includeDirectories !== false || statSync(file).isFile(),
  );
  files.sort((left, right) =>
    compareText(path.relative(stageDir, left), path.relative(stageDir, right)),
  );
  for (const file of files) {
    const relative = path.relative(stageDir, file).split(path.sep).join('/');
    const archivePath = `${packageRoot}/${relative}`;
    const stats = statSync(file);
    const isDirectory = stats.isDirectory();
    const data = isDirectory ? Buffer.alloc(0) : readFileSync(file);
    const mode =
      isDirectory || executableFiles.has(relative) ? 0o755 : (fixedFileMode ?? stats.mode & 0o777);
    chunks.push(tarHeader({ name: archivePath, isDirectory }, data.length, mode));
    chunks.push(data);
    const remainder = data.length % 512;
    if (remainder !== 0) {
      chunks.push(Buffer.alloc(512 - remainder, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

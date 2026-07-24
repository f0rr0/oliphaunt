import path from "node:path";

function archiveArgumentIndex(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--file") return index + 1;
    if (argument.startsWith("--file=")) return index;
    if (!argument.startsWith("-") || argument.startsWith("--")) continue;
    const options = argument.slice(1);
    const fileOption = options.indexOf("f");
    if (fileOption === -1) continue;
    if (fileOption !== options.length - 1) {
      throw new Error(`tar archive option must provide its path as the next argument: ${argument}`);
    }
    return index + 1;
  }
  throw new Error("tar command does not contain an explicit archive file option");
}

function portableRelativeWindowsPath(from, to, pathApi, label) {
  const relative = pathApi.relative(from, to);
  if (pathApi.isAbsolute(relative) || relative.includes(":")) {
    throw new Error(
      `tar ${label} must be on the same Windows volume as the archive: ${to}`,
    );
  }
  return (relative || ".").split(pathApi.sep).join("/");
}

function localizeWindowsDirectoryOperands(args, {
  originalCwd,
  invocationCwd,
  pathApi,
}) {
  let originalDirectory = originalCwd;
  let invocationDirectory = invocationCwd;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    let valueIndex = null;
    let assignment = false;
    if (argument === "-C" || argument === "--directory") {
      valueIndex = index + 1;
    } else if (argument.startsWith("--directory=")) {
      valueIndex = index;
      assignment = true;
    } else {
      continue;
    }
    if (valueIndex >= args.length) {
      throw new Error(`tar ${argument} option is missing its path argument`);
    }
    const raw = args[valueIndex];
    const directory = assignment ? raw.slice("--directory=".length) : raw;
    if (directory.length === 0) {
      throw new Error(`tar ${argument} option is missing its path argument`);
    }
    if (!pathApi.isAbsolute(directory) && directory.includes(":")) {
      throw new Error(
        `tar directory path must not use a drive-relative or alternate-stream form: ${directory}`,
      );
    }
    const target = pathApi.isAbsolute(directory)
      ? pathApi.normalize(directory)
      : pathApi.resolve(originalDirectory, directory);
    const localized = portableRelativeWindowsPath(
      invocationDirectory,
      target,
      pathApi,
      "directory path",
    );
    args[valueIndex] = assignment ? `--directory=${localized}` : localized;
    originalDirectory = target;
    invocationDirectory = target;
    if (!assignment) index += 1;
  }
}

export function localWindowsTarInvocation(
  args,
  {
    cwd = process.cwd(),
    platform = process.platform,
    pathApi = platform === "win32" ? path.win32 : path,
  } = {},
) {
  const invocation = { args: [...args], cwd };
  if (platform !== "win32") return invocation;
  const index = archiveArgumentIndex(invocation.args);
  if (index >= invocation.args.length) {
    throw new Error("tar archive file option is missing its path argument");
  }
  const value = invocation.args[index];
  const assignment = value.startsWith("--file=");
  const archive = assignment ? value.slice("--file=".length) : value;
  if (archive.length === 0) {
    throw new Error("tar archive file option is missing its path argument");
  }
  if (!pathApi.isAbsolute(archive)) {
    if (platform === "win32" && archive.includes(":")) {
      throw new Error(`tar archive path must not use a drive-relative or alternate-stream form: ${archive}`);
    }
    localizeWindowsDirectoryOperands(invocation.args, {
      originalCwd: cwd,
      invocationCwd: invocation.cwd,
      pathApi,
    });
    return invocation;
  }
  const directory = pathApi.dirname(archive);
  const basename = pathApi.basename(archive);
  if (basename.length === 0 || basename === pathApi.parse(archive).root) {
    throw new Error(`tar archive path does not name a file: ${archive}`);
  }
  invocation.cwd = directory;
  invocation.args[index] = assignment ? `--file=${basename}` : basename;
  // Git for Windows' tar does not reliably accept native drive-letter paths
  // as -C operands when it is launched directly by Node/Bun. Moving the
  // process beside the archive protects the -f operand, but every directory
  // operand must then be rebased as a colon-free, slash-separated relative
  // path as well. Preserve tar's sequential -C semantics while doing so.
  localizeWindowsDirectoryOperands(invocation.args, {
    originalCwd: cwd,
    invocationCwd: invocation.cwd,
    pathApi,
  });
  return invocation;
}

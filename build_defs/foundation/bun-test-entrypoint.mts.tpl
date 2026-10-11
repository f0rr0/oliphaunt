import { isAbsolute, join, resolve } from "node:path";

const configuration = @@CONFIG@@;
const declaredRoot = process.env.RUNFILES_DIR ?? process.env.TEST_SRCDIR;
if (!declaredRoot || !isAbsolute(declaredRoot)) {
  throw new Error("Bazel Bun tests require an absolute directory runfiles root");
}
const root = resolve(declaredRoot);
const args = configuration.arguments.map((argument) =>
  "file" in argument ? join(root, argument.file) : argument.literal,
);
if (configuration.runfilesArgument) args.push(root);
args.push(...process.argv.slice(2));
const environment = { ...process.env, ...configuration.environment };
for (const name of configuration.runfilesEnvironment) environment[name] = root;
// Execute the authored runner as the main module: importing it would skip
// runners guarded by import.meta.main. No script interpreter or shell is used.
const result = Bun.spawnSync(
  [process.execPath, join(root, configuration.runner), ...args],
  {
    cwd: join(root, configuration.workspace),
    env: environment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exit(result.exitCode);

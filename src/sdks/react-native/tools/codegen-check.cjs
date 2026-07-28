const path = require("node:path");
const { createRequire } = require("node:module");

const requireFromPackage = createRequire(path.join(process.cwd(), "package.json"));
const codegenPackageJson = requireFromPackage.resolve("@react-native/codegen/package.json");
const codegenRoot = path.dirname(codegenPackageJson);
const cliPath = path.join(
  codegenRoot,
  "lib/cli/combine/combine-js-to-schema-cli.js",
);

process.argv = [process.execPath, cliPath, ...process.argv.slice(2)];
require(cliPath);

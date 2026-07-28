#!/usr/bin/env bun
import { run } from "./release-cli-utils.mjs";

const TOOL = "release-consumer-shape.mjs";

run(TOOL, [process.execPath, "tools/release/check-consumer-shape.mjs", ...Bun.argv.slice(2)]);

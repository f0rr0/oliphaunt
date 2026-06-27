#!/usr/bin/env bun
import { run } from "./release-cli-utils.mjs";

const TOOL = "release-consumer-shape.mjs";

run(TOOL, ["tools/release/check_consumer_shape.py", ...Bun.argv.slice(2)]);

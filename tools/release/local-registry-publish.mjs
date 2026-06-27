#!/usr/bin/env bun
import { run } from "./release-cli-utils.mjs";

const TOOL = "local-registry-publish.mjs";

run(TOOL, ["python3", "tools/release/local_registry_publish.py", ...Bun.argv.slice(2)]);

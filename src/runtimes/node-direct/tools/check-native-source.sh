#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

command -v c++ >/dev/null || { echo "Node Direct compile requires c++" >&2; exit 1; }
node_include="$(node -e '
const path = require("node:path");
const fs = require("node:fs");
const adjacent = path.resolve(process.execPath, "../../include/node");
process.stdout.write(fs.existsSync(path.join(adjacent, "node_api.h"))
  ? adjacent
  : path.dirname(require.resolve("node-api-headers/include/node_api.h", {
      paths: [process.cwd(), path.join(process.cwd(), "src/runtimes/node-direct")]
    })));
')"
test -f "$node_include/node_api.h" || { echo "Node-API headers not found" >&2; exit 1; }

source=src/runtimes/node-direct/native/node-addon/oliphaunt_node.cc
include=src/runtimes/liboliphaunt/native/include
c++ -std=c++17 -DNAPI_VERSION=8 -DNODE_GYP_MODULE_NAME=oliphaunt_node \
  -I"$node_include" -I"$include" -fsyntax-only "$source"
c++ -std=c++17 -DNAPI_VERSION=8 -DNODE_GYP_MODULE_NAME=oliphaunt_node \
  -DOLIPHAUNT_NODE_ADDON_LIFECYCLE_TESTING=1 \
  -I"$node_include" -I"$include" -fsyntax-only "$source"
c++ -std=c++17 -DOLIPHAUNT_BUILDING_DLL -I"$include" -fsyntax-only \
  src/runtimes/node-direct/native/node-addon/fixtures/fake_liboliphaunt.cc

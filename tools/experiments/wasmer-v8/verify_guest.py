#!/usr/bin/env python3
"""Verify the immutable upgrade-PR fixture before compiling it with V8."""
import hashlib
import json
from pathlib import Path
import shutil
import sys

root, output = map(Path, sys.argv[1:])
metadata = json.loads((output / "guest-artifact.json").read_text())
assert metadata["id"] == 11312707536
assert metadata["name"] == "liboliphaunt-wasix-runtime-portable"
assert not metadata["expired"]
assert metadata["digest"] == "sha256:bec3e4c68e86d64bdd926587e2a178d730c0f3e13d49ae6805e4faefe3727b33"
assert metadata["workflow_run"]["id"] == 37225721762
assert metadata["workflow_run"]["head_sha"] == "2f942e79f10dbc3163ed6e7d54c59051efee2e03"
guest = root / "target/oliphaunt-wasix/wasix-build/build/install/bin/postgres"
digest = hashlib.sha256(guest.read_bytes()).hexdigest()
assert digest == "69fdbc72f9e110c1e356db8f46b941cb67591eff140231fcfaffff201d4e7cf9", digest
assert guest.read_bytes()[:4] == b"\0asm"
# Keep the actual guest fixture with the evidence after its producer artifact expires.
shutil.copyfile(guest, output / "postgres.wasm")
print(f"Verified PostgreSQL fixture: {digest}, {guest.stat().st_size} bytes")

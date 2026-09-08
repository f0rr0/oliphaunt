#!/usr/bin/env python3
"""Replay PostgreSQL product series without configuring or building PostgreSQL.

Usage: python3 src/postgres/versions/18/check-patches.py POSTGRESQL_ARCHIVE
Supply the existing pinned archive; nothing is downloaded or cached.
"""

import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib


REPO = Path(__file__).resolve().parents[4]
RUNTIME = REPO / "src/runtimes/liboliphaunt"
WASIX = RUNTIME / "wasix/assets/build/postgres"
POSTMASTER = RUNTIME / "wasix-postmaster/postgres"


def series(directory, manifest):
    names = [line for line in manifest.read_text().splitlines()
             if line and not line.startswith("#")]
    if len(names) != len(set(names)) or any(Path(name).name != name for name in names):
        raise ValueError(f"invalid series: {manifest}")
    return [directory / name for name in names]


def main():
    if len(sys.argv) != 2:
        raise ValueError(__doc__)
    archive = Path(sys.argv[1]).resolve()
    pin = tomllib.loads(Path(__file__).with_name("source.toml").read_text())["postgresql"]
    if hashlib.sha256(archive.read_bytes()).hexdigest() != pin["sha256"]:
        raise ValueError("PostgreSQL archive checksum mismatch")
    native_manifest = RUNTIME / "native/postgres18/source.toml"
    native = tomllib.loads(native_manifest.read_text())["patches"]
    lanes = {
        "native": [native_manifest.parent / native["directory"] / name for name in native["series"]],
        "wasix": series(WASIX / "patches", WASIX / "patches/series"),
        "postmaster": series(POSTMASTER / "patches", POSTMASTER / "patches/series")
        + series(WASIX / "patches", POSTMASTER / "main-optimizations.series"),
    }
    with tarfile.open(archive) as tar:
        members = {member.name: member for member in tar.getmembers()}
        for lane, patches in lanes.items():
            with tempfile.TemporaryDirectory(prefix=f"oliphaunt-patches-{lane}-") as temporary:
                source = Path(temporary)
                # Extract only touched source files. git apply creates new files;
                # no producer trees or build objects survive this check.
                targets = set()
                for patch in patches:
                    text = patch.read_text()
                    if not re.search(r"^From: .+", text, re.M) or not re.search(r"^Subject: \[PATCH\] .+", text, re.M):
                        raise ValueError(f"missing patch author/subject: {patch}")
                    targets.update(re.findall(r"^diff --git a/(.+?) b/", text, re.M))
                for target in sorted(targets):
                    if Path(target).is_absolute() or ".." in Path(target).parts:
                        raise ValueError(f"unsafe patch target: {target}")
                    member = members.get(f"postgresql-{pin['version']}/{target}")
                    if member is not None:
                        if not member.isfile():
                            raise ValueError(f"non-file source target: {target}")
                        destination = source / target
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        with tar.extractfile(member) as reader, destination.open("wb") as writer:
                            shutil.copyfileobj(reader, writer)
                        destination.chmod(member.mode)
                if lane == "postmaster":
                    shutil.copytree(POSTMASTER / "overlays/wasix-core", source, dirs_exist_ok=True)
                for patch in patches:
                    subprocess.run(["git", "apply", "--whitespace=error-all", str(patch.resolve())],
                                   cwd=source, env={**os.environ, "GIT_CEILING_DIRECTORIES": str(source.parent)}, check=True)
                print(f"{lane}: {len(patches)} patches applied in order with full context and strict whitespace", flush=True)


if __name__ == "__main__":
    main()

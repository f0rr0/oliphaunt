#!/usr/bin/env python3

"""Static and optional clean-apply checks for the semantic cache-offer seam."""

from __future__ import annotations

import argparse
import re
import subprocess
import tomllib
from pathlib import Path


PATCH_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = PATCH_DIR.parents[1]
PATCH_NAME = "0007-wasix-semantic-relation-cache-offers.patch"
PATCH_PATH = PATCH_DIR / PATCH_NAME


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def require_text(contents: str, expected: str) -> None:
    require(expected in contents, f"patch lacks required text: {expected}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--postgres-source",
        type=Path,
        help="optional clean REL_18_4 git worktree for git apply --check",
    )
    options = parser.parse_args()

    patch = PATCH_PATH.read_text(encoding="utf-8")
    series = (PATCH_DIR / "series").read_text(encoding="utf-8").splitlines()
    require(series.count(PATCH_NAME) == 1, "cache-offer patch must occur once in series")
    require(
        series.index(PATCH_NAME)
        < series.index("0008-wasix-packed-atomic-latch-state.patch")
        < series.index("0009-wasix-inactive-durable-wal-cache-offer.patch"),
        "relation cache-offer ABI must precede its latch and WAL consumers",
    )

    provenance_path = PROJECT_ROOT / "postgres/product-patch-provenance.toml"
    with provenance_path.open("rb") as handle:
        provenance = tomllib.load(handle)
    records = provenance.get("patch", [])
    record = next(
        (
            item
            for item in records
            if item.get("path") == f"postgres/patches/{PATCH_NAME}"
        ),
        None,
    )
    require(record is not None, "cache-offer patch provenance is missing")
    require(record.get("base_tag") == "REL_18_4", "provenance base tag changed")
    require(record.get("status") == "guest-seam-only", "provenance status changed")
    require(record.get("abi_available") is True, "provenance disabled the selected ABI")
    require(
        record.get("abi")
        == "oliphaunt_postmaster_v1.fd_cache_offer(i32,i64,i64,i32,i32)->i32_errno",
        "provenance ABI changed",
    )

    changed_paths = set(re.findall(r"^diff --git a/(\S+) b/(\S+)$", patch, re.MULTILINE))
    expected_paths = {
        ("src/backend/storage/buffer/bufmgr.c", "src/backend/storage/buffer/bufmgr.c"),
        ("src/backend/storage/file/fd.c", "src/backend/storage/file/fd.c"),
        ("src/backend/storage/smgr/md.c", "src/backend/storage/smgr/md.c"),
        ("src/backend/storage/smgr/smgr.c", "src/backend/storage/smgr/smgr.c"),
        ("src/include/port.h", "src/include/port.h"),
        ("src/include/storage/fd.h", "src/include/storage/fd.h"),
        ("src/include/storage/md.h", "src/include/storage/md.h"),
        ("src/include/storage/smgr.h", "src/include/storage/smgr.h"),
    }
    require(changed_paths == expected_paths, f"unexpected patch paths: {changed_paths}")

    for expected in (
        "ProcessReadBuffersResult(ReadBuffersOperation *operation)",
        "operation->persistence != RELPERSISTENCE_TEMP",
        "operation->blocknum + operation->nblocks_done",
        "newly_read_blocks, offer_class",
        "IOContextForStrategy(operation->strategy)",
        "SMGR_CACHE_OFFER_RELATION_READ_NORMAL = 1",
        "SMGR_CACHE_OFFER_RELATION_READ_BULK = 2",
        "SMGR_CACHE_OFFER_RELATION_READ_VACUUM = 3",
        "SMGR_CACHE_OFFER_RELATION_SYNC_CHECKPOINT = 4",
        "SMGR_CACHE_OFFER_RELATION_SYNC_IMMEDIATE = 5",
        "EXTENSION_DONT_OPEN",
        "RELSEG_SIZE - segoff",
        "if (!FileIsValid(file) || FileIsNotOpen(file))",
        "result = EBADF",
        "if (result == 0)",
        "PG_WASIX_HAVE_FD_CACHE_OFFER_V1",
        "#include <wasix/cache_offer.h>",
        "result = ENOSYS",
        "errno = save_errno",
    ):
        require_text(patch, expected)

    require(patch.count("#ifdef __wasi__") >= 8, "WASIX guards are incomplete")
    require("src/backend/access/transam/xlog.c" not in patch, "WAL behavior changed")
    require("POSIX_FADV_DONTNEED" not in patch, "guest seam must not force eviction")
    require("FileAccess(file);" not in patch, "cache hint must not reopen a VFD")
    require("PathNameOpenFile" not in patch, "cache hint must not scan or reopen paths")
    require(
        "extern int pg_wasix_fd_cache_offer_v1" not in patch,
        "the PostgreSQL seam must use the canonical public libc declaration",
    )

    immediate_function = patch.index("mdimmedsync(SMgrRelation reln")
    immediate_error = patch.index("could not fsync file", immediate_function)
    immediate_offer = patch.index(
        "SMGR_CACHE_OFFER_RELATION_SYNC_IMMEDIATE", immediate_error
    )
    checkpoint_sync = patch.index("result = FileSync(file, WAIT_EVENT_DATA_FILE_SYNC)")
    checkpoint_offer = patch.index("SMGR_CACHE_OFFER_RELATION_SYNC_CHECKPOINT", checkpoint_sync)
    require(immediate_offer > immediate_error, "immediate offer must follow fsync error check")
    require(checkpoint_offer > checkpoint_sync, "checkpoint offer must follow FileSync")

    if options.postgres_source is not None:
        source = options.postgres_source.resolve()
        result = subprocess.run(
            ["git", "-C", str(source), "apply", "--check", str(PATCH_PATH)],
            check=False,
            capture_output=True,
            text=True,
        )
        require(
            result.returncode == 0,
            f"patch does not apply to {source}: {result.stdout}{result.stderr}",
        )

    print("semantic relation cache-offer patch checks passed")


if __name__ == "__main__":
    main()

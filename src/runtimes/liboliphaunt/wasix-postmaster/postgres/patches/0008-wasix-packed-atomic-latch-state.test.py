#!/usr/bin/env python3

"""Static and optional REL_18_4 apply checks for the packed latch state."""

from __future__ import annotations

import argparse
import re
import subprocess
import tempfile
import tomllib
from pathlib import Path


PATCH_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = PATCH_DIR.parents[1]
PATCH_NAME = "0008-wasix-packed-atomic-latch-state.patch"
PATCH_PATH = PATCH_DIR / PATCH_NAME
FEATURE = "PG_WASIX_ATOMIC_LATCH_STATE"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def require_text(contents: str, expected: str) -> None:
    require(expected in contents, f"patch lacks required text: {expected}")


def function_body(contents: str, start: str, end: str) -> str:
    start_offset = contents.index(start)
    end_offset = contents.index(end, start_offset + len(start))
    return contents[start_offset:end_offset]


def assert_order(contents: str, *needles: str) -> None:
    cursor = 0
    for needle in needles:
        offset = contents.find(needle, cursor)
        require(offset >= 0, f"wrong or missing operation order: {needles}")
        cursor = offset + len(needle)


def run_git_apply_check(source: Path, patches: list[Path], label: str) -> None:
    result = subprocess.run(
        ["git", "-C", str(source), "apply", "--check", *map(str, patches)],
        check=False,
        capture_output=True,
        text=True,
    )
    require(
        result.returncode == 0,
        f"{label} does not apply to {source}: {result.stdout}{result.stderr}",
    )


def run_full_series_apply_check(source: Path, patches: list[Path]) -> None:
    with tempfile.TemporaryDirectory(prefix="pg-packed-latch-series-") as temporary:
        checkout = Path(temporary) / "postgres"
        added = subprocess.run(
            ["git", "-C", str(source), "worktree", "add", "--detach", str(checkout), "HEAD"],
            check=False,
            capture_output=True,
            text=True,
        )
        require(
            added.returncode == 0,
            f"could not create isolated series worktree: {added.stdout}{added.stderr}",
        )
        try:
            for patch in patches:
                applied = subprocess.run(
                    ["git", "-C", str(checkout), "apply", str(patch)],
                    check=False,
                    capture_output=True,
                    text=True,
                )
                require(
                    applied.returncode == 0,
                    f"ordered full series failed at {patch.name}: "
                    f"{applied.stdout}{applied.stderr}",
                )
        finally:
            subprocess.run(
                ["git", "-C", str(source), "worktree", "remove", "--force", str(checkout)],
                check=False,
                capture_output=True,
                text=True,
            )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--postgres-source",
        type=Path,
        help="optional clean PostgreSQL 18.4 git worktree for apply checks",
    )
    options = parser.parse_args()

    patch = PATCH_PATH.read_text(encoding="utf-8")
    series = [
        line
        for line in (PATCH_DIR / "series").read_text(encoding="utf-8").splitlines()
        if line and not line.startswith("#")
    ]
    require(series.count(PATCH_NAME) == 1, "packed-latch patch must occur once")
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
    require(record is not None, "packed-latch patch provenance is missing")
    require(record.get("base_tag") == "REL_18_4", "provenance base tag changed")
    require(record.get("status") == "guest-correctness-seam", "status changed")
    require(record.get("feature_macro") == FEATURE, "feature macro changed")
    require(record.get("native_behavior_preserved") is True, "native guard changed")

    changed_paths = set(re.findall(r"^diff --git a/(\S+) b/(\S+)$", patch, re.MULTILINE))
    expected_paths = {
        ("src/backend/storage/ipc/latch.c", "src/backend/storage/ipc/latch.c"),
        (
            "src/backend/storage/ipc/waiteventset.c",
            "src/backend/storage/ipc/waiteventset.c",
        ),
        ("src/include/storage/latch.h", "src/include/storage/latch.h"),
    }
    require(changed_paths == expected_paths, f"unexpected patch paths: {changed_paths}")

    removed_lines = [
        line
        for line in patch.splitlines()
        if line.startswith("-") and not line.startswith("--- ")
    ]
    require(
        not removed_lines,
        "the patch must retain every upstream native source line under #else",
    )

    for expected in (
        "#ifdef PG_WASIX_ATOMIC_LATCH_STATE",
        '#error "PG_WASIX_ATOMIC_LATCH_STATE is only supported by the WASIX port"',
        '#error "PG_WASIX_ATOMIC_LATCH_STATE requires native SC uint32 atomics"',
        "!defined(HAVE_GCC__SYNC_INT32_CAS)",
        "pg_atomic_uint32 state;",
        "uint32\t\tstate_reserved;",
        "PG_WASIX_LATCH_STATE_SET\t\t((uint32) 1)",
        "PG_WASIX_LATCH_STATE_SLEEPING\t((uint32) 2)",
        "sizeof(Latch) == sizeof(PGWasixUpstreamLatchLayout)",
        "offsetof(Latch, state_reserved) ==",
        "offsetof(Latch, owner_pid) ==",
        "__atomic_always_lock_free(sizeof(uint32), 0)",
        "__atomic_load_n(&latch->state.value, __ATOMIC_SEQ_CST)",
        "pg_atomic_fetch_or_u32(&latch->state",
        "pg_atomic_fetch_and_u32(&latch->state",
        "pg_atomic_fetch_or_u32(&set->latch->state",
        "pg_atomic_fetch_and_u32(&set->latch->state",
        "pg_wasix_latch_state_is_set_and_sleeping(set->latch)",
    ):
        require_text(patch, expected)

    require(
        "return pg_atomic_read_u32" not in patch,
        "the latch predicate must not use PostgreSQL's non-SC read fallback",
    )
    require(
        patch.count("pg_wasix_latch_state_is_set_and_sleeping(set->latch)") == 4,
        "every epoll, kqueue, poll, and Win32 fallback must use the atomic state",
    )
    require(
        patch.count("set->latch->maybe_sleeping && set->latch->is_set") == 4,
        "all four upstream platform checks must remain in native #else branches",
    )

    set_latch = function_body(patch, "SetLatch(Latch *latch)", "ResetLatch(Latch *latch)")
    assert_order(
        set_latch,
        "pg_memory_barrier();",
        "old_state = pg_atomic_fetch_or_u32",
        "if (old_state & PG_WASIX_LATCH_STATE_SET)",
        "pg_memory_barrier();",
        "if (!(old_state & PG_WASIX_LATCH_STATE_SLEEPING))",
    )
    require(
        set_latch.count("pg_atomic_fetch_or_u32") == 1,
        "SetLatch must publish and test the packed state once",
    )

    reset_latch = patch[patch.index("ResetLatch(Latch *latch)") :]
    assert_order(
        reset_latch,
        "Assert(latch->owner_pid == MyProcPid);",
        "Assert(!pg_wasix_latch_state_is_sleeping(latch));",
        "pg_atomic_fetch_and_u32(&latch->state",
        "pg_memory_barrier();",
    )
    require(
        "~PG_WASIX_LATCH_STATE_SET" in reset_latch,
        "ResetLatch must preserve SLEEPING while clearing SET",
    )

    wait = function_body(
        patch,
        "WaitEventSetWait(WaitEventSet *set, long timeout,",
        "WaitEventSetWaitBlock(WaitEventSet *set, int cur_timeout,",
    )
    assert_order(
        wait,
        "pg_atomic_fetch_or_u32(&set->latch->state",
        "pg_memory_barrier();",
        "pg_wasix_latch_state_is_set(set->latch)",
        "pg_atomic_fetch_and_u32(&set->latch->state",
        "WaitEventSetWaitBlock(set, cur_timeout",
        "pg_atomic_fetch_and_u32(&set->latch->state",
    )
    require(
        wait.count("pg_atomic_fetch_or_u32(&set->latch->state") == 1,
        "the waiter must publish SLEEPING exactly once per wait-loop iteration",
    )
    require(
        wait.count("pg_atomic_fetch_and_u32(&set->latch->state") == 2,
        "the waiter must retract SLEEPING on the already-set and wake paths",
    )

    added_lines = [line[1:] for line in patch.splitlines() if line.startswith("+")]
    added_text = "\n".join(added_lines)
    for forbidden in ("errno =", "WakeupMyProc(", "WakeupOtherProc(", "kill(", "SetEvent("):
        require(
            forbidden not in added_text,
            f"packed-state code must not alter signal/errno behavior: {forbidden}",
        )

    if options.postgres_source is not None:
        source = options.postgres_source.resolve()
        require((source / ".git").exists() or (source / ".git").is_file(), "not a git worktree")
        status = subprocess.run(
            ["git", "-C", str(source), "status", "--porcelain"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        require(status == "", "PostgreSQL apply-check source must be clean")
        configure_ac = (source / "configure.ac").read_text(encoding="utf-8")
        require("AC_INIT([PostgreSQL], [18.4]" in configure_ac, "source is not 18.4")

        run_git_apply_check(source, [PATCH_PATH], "standalone packed-latch patch")
        run_full_series_apply_check(source, [PATCH_DIR / name for name in series])

        direct_access_paths: set[str] = set()
        for candidate in (source / "src").rglob("*"):
            if candidate.suffix not in {".c", ".h"} or not candidate.is_file():
                continue
            contents = candidate.read_text(encoding="utf-8", errors="ignore")
            if "->maybe_sleeping" in contents:
                direct_access_paths.add(candidate.relative_to(source).as_posix())
        require(
            direct_access_paths
            == {
                "src/backend/storage/ipc/latch.c",
                "src/backend/storage/ipc/waiteventset.c",
            },
            f"unreviewed direct latch-state access paths: {direct_access_paths}",
        )

    print("packed atomic latch-state patch checks passed")


if __name__ == "__main__":
    main()

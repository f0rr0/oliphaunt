#!/usr/bin/env python3

"""Static, state-machine, and REL_18_4 apply checks for WAL cache offers."""

from __future__ import annotations

import argparse
import re
import subprocess
import tempfile
import tomllib
from dataclasses import dataclass
from pathlib import Path


PATCH_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = PATCH_DIR.parents[1]
PATCH_NAME = "0009-wasix-inactive-durable-wal-cache-offer.patch"
PATCH_PATH = PATCH_DIR / PATCH_NAME
OFFER_CLASS = "PG_WASIX_CACHE_CLASS_WAL_INACTIVE_DURABLE"
RECLAIM_FLAG = "PG_WASIX_CACHE_OFFER_V1_FLAG_WAL_RECLAIM_ELIGIBLE"
CACHE_DROP_SAFE_FLAG = "PG_WASIX_CACHE_OFFER_V1_FLAG_WAL_CACHE_DROP_SAFE"
REVOKE_FUNCTION = "pg_wasix_fd_cache_revoke_v1"
RECLAIM_FLAG_VALUE = 1 << 0
CACHE_DROP_SAFE_FLAG_VALUE = 1 << 1


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def require_text(contents: str, expected: str) -> None:
    require(expected in contents, f"patch lacks required text: {expected}")


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
    with tempfile.TemporaryDirectory(prefix="pg-wal-cache-offer-series-") as temporary:
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
            verify_applied_source(checkout)
        finally:
            subprocess.run(
                ["git", "-C", str(source), "worktree", "remove", "--force", str(checkout)],
                check=False,
                capture_output=True,
                text=True,
            )


def verify_applied_source(source: Path) -> None:
    xlog = (source / "src/backend/access/transam/xlog.c").read_text(encoding="utf-8")
    walreceiver = (
        source / "src/backend/replication/walreceiver.c"
    ).read_text(encoding="utf-8")

    assignments = list(
        re.finditer(r"openLogFile = XLogFile(?:Init|Open)\([^;]+\);", xlog)
    )
    require(len(assignments) == 4, "REL_18_4 openLogFile assignment inventory changed")
    for assignment in assignments:
        following = xlog[assignment.end() : assignment.end() + 240]
        require(
            "XLogFileCacheOfferOpened(" in following,
            f"openLogFile assignment lacks generation reset: {assignment.group(0)}",
        )

    write_start = xlog.index("XLogWrite(XLogwrtRqst WriteRqst")
    write_end = xlog.index("XLogSetAsyncXactLSN", write_start)
    write = xlog[write_start:write_end]
    require(
        write.count("XLogFileCacheOfferCompleted(") == 1,
        "only finishing_seg may establish the completion proof",
    )
    write_started = write.index("XLogFileCacheOfferWriteStarted(")
    write_call = write.index("pg_pwrite(openLogFile", write_started)
    require(
        write_started < write_call,
        "normal WAL revoke state must advance before the first payload write",
    )
    finish = write.index("if (finishing_seg)")
    sync = write.index("issue_xlog_fsync(openLogFile, openLogSegNo, tli);", finish)
    completed = write.index("XLogFileCacheOfferCompleted(", sync)
    wake = write.index("WalSndWakeupRequest();", completed)
    require(finish < sync < completed < wake, "finishing durability transition moved")

    close_start = xlog.index("XLogFileClose(void)\n{")
    close_end = xlog.index("PreallocXlogFiles", close_start)
    close = xlog[close_start:close_end]
    take = close.index("XLogFileCacheOfferTake(")
    buffered_predicate = close.index(
        "if ((io_direct_flags & IO_DIRECT_WAL) == 0)", take
    )
    cache_drop_safe_flag = close.index(CACHE_DROP_SAFE_FLAG, buffered_predicate)
    low_reuse_predicate = close.index("if (!XLogIsNeeded())", cache_drop_safe_flag)
    reclaim_flag = close.index(RECLAIM_FLAG, low_reuse_predicate)
    offer = close.index("pg_wasix_cache_offer(", reclaim_flag)
    os_advice = close.index("posix_fadvise(", offer)
    close_fd = close.index("close(openLogFile)", os_advice)
    require(
        take
        < buffered_predicate
        < cache_drop_safe_flag
        < low_reuse_predicate
        < reclaim_flag
        < offer
        < os_advice
        < close_fd,
        "durable safety proof and legacy reuse hint must precede descriptor close",
    )
    require(close.count("pg_wasix_cache_offer(") == 1, "close emits at most one offer")

    helper_start = xlog.index("XLogFileCacheOfferWriteStarted(int fd")
    helper_end = xlog.index("XLogFileCacheOfferCompleted(int fd", helper_start)
    helper = xlog[helper_start:helper_end]
    pending_clear = helper.index("revoke_before_first_write = false;")
    revoke = helper.index(f"{REVOKE_FUNCTION}(", pending_clear)
    require(
        pending_clear < revoke,
        "normal-writer revoke must be attempted at most once per open generation",
    )

    bootstrap_start = xlog.index("BootStrapXLOG(uint32 data_checksum_version)")
    bootstrap_end = xlog.index("BootStrapCLOG", bootstrap_start)
    bootstrap = xlog[bootstrap_start:bootstrap_end]
    bootstrap_open = bootstrap.index("XLogFileCacheOfferOpened(")
    bootstrap_revoke = bootstrap.index("XLogFileCacheOfferWriteStarted(", bootstrap_open)
    bootstrap_write = bootstrap.index("write(openLogFile", bootstrap_revoke)
    require(
        bootstrap_open < bootstrap_revoke < bootstrap_write,
        "bootstrap revoke must be once-per-open and precede its first WAL write",
    )

    receiver_open = walreceiver.index("recvFile = XLogFileInit(")
    receiver_opened = walreceiver.index("XLogWalRcvCacheRevokeOpened(", receiver_open)
    receiver_before_write = walreceiver.index(
        "XLogWalRcvCacheRevokeBeforeFirstWrite(", receiver_opened
    )
    receiver_errno = walreceiver.index("errno = 0;", receiver_before_write)
    receiver_write = walreceiver.index("pg_pwrite(recvFile", receiver_errno)
    require(
        receiver_open
        < receiver_opened
        < receiver_before_write
        < receiver_errno
        < receiver_write,
        "walreceiver revoke must precede timing and its first payload write",
    )
    receiver_helper_start = walreceiver.index(
        "XLogWalRcvCacheRevokeBeforeFirstWrite(int fd"
    )
    receiver_helper_end = walreceiver.index("#endif", receiver_helper_start)
    receiver_helper = walreceiver[receiver_helper_start:receiver_helper_end]
    receiver_pending_clear = receiver_helper.index("pending = false;")
    receiver_revoke = receiver_helper.index(
        f"{REVOKE_FUNCTION}(", receiver_pending_clear
    )
    require(
        receiver_pending_clear < receiver_revoke,
        "walreceiver revoke must be attempted at most once per open generation",
    )
    require(
        walreceiver.count("XLogWalRcvCacheRevokeReset();") == 2,
        "every walreceiver descriptor close must clear revoke generation state",
    )


@dataclass
class OfferState:
    fd: int = -1
    segno: int = 0
    tli: int = 0
    sync_open_writes: bool = False
    revoke_before_first_write: bool = False
    complete_and_durable: bool = False

    def reset(self) -> None:
        self.fd = -1
        self.segno = 0
        self.tli = 0
        self.sync_open_writes = False
        self.revoke_before_first_write = False
        self.complete_and_durable = False

    def opened(
        self,
        identity: tuple[int, int, int],
        *,
        fsync_enabled: bool = True,
        sync_open_method: bool = False,
    ) -> None:
        self.fd, self.segno, self.tli = identity
        self.sync_open_writes = fsync_enabled and sync_open_method
        self.revoke_before_first_write = True
        self.complete_and_durable = False

    def write_started(self, identity: tuple[int, int, int]) -> bool:
        require(self.identity == identity, "test issued a write for the wrong generation")
        revoked = self.revoke_before_first_write
        self.revoke_before_first_write = False
        self.complete_and_durable = False
        return revoked

    def completed(
        self,
        identity: tuple[int, int, int],
        fsync_enabled: bool,
        *,
        sync_open_method: bool = False,
    ) -> None:
        durability_proved = fsync_enabled and (
            not sync_open_method or self.sync_open_writes
        )
        self.complete_and_durable = durability_proved and self.identity == identity

    def take(self, identity: tuple[int, int, int]) -> bool:
        eligible = self.complete_and_durable and self.identity == identity
        self.reset()
        return eligible

    @property
    def identity(self) -> tuple[int, int, int]:
        return self.fd, self.segno, self.tli


def verify_state_machine() -> None:
    identities = (
        (7, 41, 1),
        (7, 42, 1),  # same reused FD, different segment
        (8, 41, 1),  # same segment, different FD
        (7, 41, 2),  # same FD and segment, different timeline
    )

    # Exhaust every proof/close identity pairing, fsync and sync-open mode,
    # and stale state. This includes a SIGHUP-style false->true fsync change on
    # an already open descriptor, which must not fabricate O_SYNC/O_DSYNC.
    for opened in identities:
        for completed in identities:
            for closed in identities:
                for open_fsync in (False, True):
                    for open_sync_method in (False, True):
                        for complete_fsync in (False, True):
                            for complete_sync_method in (False, True):
                                state = OfferState()
                                state.opened(
                                    opened,
                                    fsync_enabled=open_fsync,
                                    sync_open_method=open_sync_method,
                                )
                                state.completed(
                                    completed,
                                    complete_fsync,
                                    sync_open_method=complete_sync_method,
                                )
                                sync_open_proved = (
                                    not complete_sync_method
                                    or (open_fsync and open_sync_method)
                                )
                                expected = (
                                    complete_fsync
                                    and sync_open_proved
                                    and opened == completed == closed
                                )
                                require(
                                    state.take(closed) is expected,
                                    "identity/durability predicate accepted stale state",
                                )
                                require(
                                    state == OfferState(),
                                    "take must reset every generation field",
                                )

    state = OfferState()
    state.opened(identities[0])
    require(not state.take(identities[0]), "open-but-unwritten WAL became eligible")

    state.opened(identities[0])
    require(state.write_started(identities[0]), "first write did not revoke")
    require(
        not state.write_started(identities[0]),
        "one open generation revoked more than once",
    )
    require(not state.take(identities[0]), "partial WAL became eligible")

    state.opened(identities[0])
    require(state.write_started(identities[0]), "reopen did not create a new revoke")
    state.opened(identities[0])
    require(state.write_started(identities[0]), "same-identity reopen was not revoked")

    state.opened(identities[0])
    require(state.write_started(identities[0]), "initial proof write did not revoke")
    state.completed(identities[0], True)
    require(
        not state.write_started(identities[0]),
        "later write repeated the open-generation revoke",
    )
    require(not state.take(identities[0]), "a later write retained a stale proof")

    state.opened(identities[0])
    state.completed(identities[0], True)
    state.opened(identities[1])
    require(not state.take(identities[1]), "FD reuse inherited prior eligibility")

    state.opened(identities[0])
    state.completed(identities[0], True)
    require(state.take(identities[0]), "complete durable exact generation was not offered")
    require(not state.take(identities[0]), "a completion proof was consumed twice")

    # Given a consumed complete-and-durable generation proof, bit 1 is exactly
    # the cache-drop safety proof: the descriptor is buffered, and later readers
    # can refault the still-present file. Bit 0 retains its exact legacy predicate
    # as a low-reuse hint for compatibility; it is deliberately not a safety proof.
    for xlog_needed in (False, True):
        for io_direct_wal in (False, True):
            flags = 0
            if not io_direct_wal:
                flags |= CACHE_DROP_SAFE_FLAG_VALUE
                if not xlog_needed:
                    flags |= RECLAIM_FLAG_VALUE
            require(
                bool(flags & RECLAIM_FLAG_VALUE)
                is (not xlog_needed and not io_direct_wal),
                "legacy WAL low-reuse flag diverged from its existing predicate",
            )
            require(
                bool(flags & CACHE_DROP_SAFE_FLAG_VALUE) is (not io_direct_wal),
                "WAL cache-drop safety flag lacks the non-direct-I/O proof",
            )
            require(
                not (flags & RECLAIM_FLAG_VALUE)
                or bool(flags & CACHE_DROP_SAFE_FLAG_VALUE),
                "legacy low-reuse flag must never appear without the safety proof",
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
    require(series.count(PATCH_NAME) == 1, "WAL cache-offer patch must occur once")
    require(series[-1] == PATCH_NAME, "WAL cache-offer patch must be final in series")
    require(
        series.index("0007-wasix-semantic-relation-cache-offers.patch")
        < series.index(PATCH_NAME),
        "the cache-offer wrapper must precede the WAL consumer",
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
    require(record is not None, "WAL cache-offer provenance is missing")
    require(record.get("base_tag") == "REL_18_4", "provenance base tag changed")
    require(record.get("status") == "guest-semantic-seam", "status changed")
    require(record.get("offer_class") == OFFER_CLASS, "offer class changed")
    require(record.get("reclaim_eligible_flag") == RECLAIM_FLAG, "reclaim flag changed")
    require(
        record.get("reclaim_eligible_flag_value") == RECLAIM_FLAG_VALUE,
        "reclaim flag value changed",
    )
    require(
        record.get("reclaim_eligible_flag_semantics")
        == "legacy-low-reuse-hint-only",
        "legacy bit 0 was promoted into a correctness proof",
    )
    require(
        record.get("cache_drop_safe_flag") == CACHE_DROP_SAFE_FLAG,
        "cache-drop safety flag changed",
    )
    require(
        record.get("cache_drop_safe_flag_value") == CACHE_DROP_SAFE_FLAG_VALUE,
        "cache-drop safety flag value changed",
    )
    require(
        record.get("cache_drop_safe_flag_semantics")
        == "positive-complete-durable-nondirect-cache-drop-proof",
        "bit 1 safety semantics changed",
    )
    require(
        record.get("unflagged_disposition") == "retain",
        "unflagged class-6 offers must fail closed",
    )
    require(
        record.get("revoke_abi")
        == "oliphaunt_postmaster_v1.fd_cache_revoke(i32,i32,i32)->i32_errno",
        "revoke ABI changed",
    )
    require(record.get("revoke_class") == OFFER_CLASS, "revoke class changed")
    require(record.get("revoke_class_value") == 6, "revoke class value changed")
    require(
        record.get("revoke_flags") == "PG_WASIX_CACHE_OFFER_V1_FLAGS_NONE",
        "revoke flags changed",
    )
    require(record.get("revoke_flags_value") == 0, "revoke flags value changed")
    require(
        record.get("revoke_timing")
        == "once-per-open-before-first-wal-payload-write",
        "revoke timing changed",
    )
    require(record.get("native_behavior_preserved") is True, "native guard changed")
    require(record.get("adaptive_eviction_enabled") is True, "adaptive product policy disabled")
    require(
        record.get("adaptive_policy_id")
        == "oliphaunt.wasix-postmaster.file-cache.adaptive-linux.v5",
        "adaptive product policy identity changed",
    )
    require(
        record.get("adaptive_required_flag") == CACHE_DROP_SAFE_FLAG,
        "adaptive WAL action no longer requires bit 1",
    )
    require(
        record.get("adaptive_portable_fallback") == "observe-only",
        "adaptive portable fallback changed",
    )

    changed_paths = set(re.findall(r"^diff --git a/(\S+) b/(\S+)$", patch, re.MULTILINE))
    require(
        changed_paths
        == {
            (
                "src/backend/access/transam/xlog.c",
                "src/backend/access/transam/xlog.c",
            ),
            (
                "src/backend/replication/walreceiver.c",
                "src/backend/replication/walreceiver.c",
            ),
        },
        f"unexpected patch paths: {changed_paths}",
    )

    removed_lines = [
        line for line in patch.splitlines() if line.startswith("-") and not line.startswith("--- ")
    ]
    require(not removed_lines, "WAL seam must retain every upstream source line")

    for expected in (
        "typedef struct XLogFileCacheOfferState",
        "int\t\t\tfd;",
        "XLogSegNo\tsegno;",
        "TimeLineID\ttli;",
        "bool\t\tsync_open_writes;",
        "bool\t\trevoke_before_first_write;",
        "bool\t\tcomplete_and_durable;",
        "XLogFileCacheOfferOpened(int fd, XLogSegNo segno, TimeLineID tli)",
        "XLogFileCacheOfferWriteStarted(int fd, XLogSegNo segno, TimeLineID tli)",
        "XLogFileCacheOfferCompleted(int fd, XLogSegNo segno, TimeLineID tli)",
        "XLogFileCacheOfferTake(int fd, XLogSegNo segno, TimeLineID tli)",
        "XLogWalRcvCacheRevokeOpened(int fd, XLogSegNo segno, TimeLineID tli)",
        "XLogWalRcvCacheRevokeBeforeFirstWrite(int fd, XLogSegNo segno,",
        REVOKE_FUNCTION,
        "enableFsync &&",
        "wal_sync_method == WAL_SYNC_METHOD_OPEN",
        "wal_sync_method == WAL_SYNC_METHOD_OPEN_DSYNC",
        "durability_proved = enableFsync;",
        "openLogFileCacheOffer.sync_open_writes;",
        "if (finishing_seg)",
        "issue_xlog_fsync(openLogFile, openLogSegNo, tli);",
        "XLogFileCacheOfferCompleted(openLogFile, openLogSegNo, tli);",
        "XLogFileCacheOfferTake(openLogFile, openLogSegNo,",
        "(off_t) wal_segment_size",
        OFFER_CLASS,
        "PG_WASIX_CACHE_OFFER_V1_FLAGS_NONE",
        "if ((io_direct_flags & IO_DIRECT_WAL) == 0)",
        "if (!XLogIsNeeded())",
        RECLAIM_FLAG,
        CACHE_DROP_SAFE_FLAG,
        "cache_offer_flags",
        "Bootstrap WAL is a partial segment and must never become eligible.",
    ):
        require_text(patch, expected)

    require(patch.count("#ifdef __wasi__") == 16, "WASIX guard inventory changed")
    require(
        patch.count("XLogFileCacheOfferOpened(") == 5,
        "every normal and bootstrap global open must reset the generation",
    )
    require(
        patch.count("XLogFileCacheOfferWriteStarted(") == 3,
        "normal and bootstrap writers must traverse the revoke state",
    )
    require(
        patch.count("XLogFileCacheOfferCompleted(") == 2,
        "only finishing_seg may establish a completion proof",
    )
    require(patch.count("pg_wasix_cache_offer(") == 1, "offer call count changed")
    require(patch.count(REVOKE_FUNCTION + "(") == 2, "revoke call inventory changed")
    require(patch.count(OFFER_CLASS) == 3, "WAL class use count changed")
    require(
        patch.count("XLogWalRcvCacheRevokeOpened(") == 2,
        "walreceiver open-generation inventory changed",
    )
    require(
        patch.count("XLogWalRcvCacheRevokeBeforeFirstWrite(") == 2,
        "walreceiver first-write inventory changed",
    )
    require(patch.count(RECLAIM_FLAG) == 1, "WAL reclaim flag use count changed")
    require(
        patch.count(CACHE_DROP_SAFE_FLAG) == 1,
        "WAL cache-drop safety flag use count changed",
    )
    require(patch.count("XLogIsNeeded()") == 1, "release predicate use count changed")

    added_lines = [line[1:] for line in patch.splitlines() if line.startswith("+")]
    added_text = "\n".join(added_lines)
    for forbidden in (
        "posix_fadvise(",
        "enableFsync =",
        "fullPageWrites =",
        "synchronous_commit",
        "wal_level",
        "wal_recycle",
        "unlink(",
        "rename(",
        "close(openLogFile)",
    ):
        require(forbidden not in added_text, f"guest seam changed policy/durability: {forbidden}")

    finish = patch.index("if (finishing_seg)")
    sync = patch.index("issue_xlog_fsync(openLogFile, openLogSegNo, tli);", finish)
    completed = patch.index("XLogFileCacheOfferCompleted(openLogFile", sync)
    require(finish < sync < completed, "completion proof must follow finishing sync")
    take = patch.index("XLogFileCacheOfferTake(openLogFile")
    buffered_predicate = patch.index("if ((io_direct_flags & IO_DIRECT_WAL) == 0)", take)
    cache_drop_safe_flag = patch.index(CACHE_DROP_SAFE_FLAG, buffered_predicate)
    low_reuse_predicate = patch.index("if (!XLogIsNeeded())", cache_drop_safe_flag)
    reclaim_flag = patch.index(RECLAIM_FLAG, low_reuse_predicate)
    offer = patch.index("pg_wasix_cache_offer(openLogFile", reclaim_flag)
    require(
        take
        < buffered_predicate
        < cache_drop_safe_flag
        < low_reuse_predicate
        < reclaim_flag
        < offer,
        "proof, cache-drop safety, and low-reuse hint must precede the offer",
    )

    verify_state_machine()

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

        run_git_apply_check(source, [PATCH_PATH], "standalone WAL cache-offer patch")
        run_full_series_apply_check(source, [PATCH_DIR / name for name in series])

    print("inactive durable WAL cache-offer patch checks passed")


if __name__ == "__main__":
    main()

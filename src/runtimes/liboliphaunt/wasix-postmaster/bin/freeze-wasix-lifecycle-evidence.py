#!/usr/bin/env python3

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import re
import secrets
import stat
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from durable_publication import (  # noqa: E402
    MAX_PUBLICATION_BYTES,
    PublicationError,
    publish_set,
    remove_private,
    write_bytes,
)


NONCE_RE = re.compile(r"^[0-9a-f]{32}$")
COMMIT_PREFIX = b"wasix-runtime-fence-commit-v1"
U64_MAX = (1 << 64) - 1


class FreezeError(ValueError):
    pass


@dataclass(frozen=True)
class CommitAck:
    raw: bytes
    sha256: str
    nonce: str
    sequence: int
    mono_ns: int
    phase: str
    observer_pid: int
    observer_tid: int
    request_sequence: int
    fence_end_offset: int


def file_identity(metadata: os.stat_result) -> tuple[int, ...]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def parse_positive_u64(value: bytes, field: str) -> int:
    if not value.isascii() or not value.isdigit():
        raise FreezeError(f"committed ACK {field} must be an unsigned decimal integer")
    parsed = int(value)
    if parsed <= 0 or parsed > U64_MAX:
        raise FreezeError(f"committed ACK {field} must be a positive u64")
    return parsed


def read_regular_file(path: Path, *, byte_limit: int | None = None) -> tuple[bytes, int]:
    before = os.lstat(path)
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise FreezeError(f"lifecycle evidence input is not a regular non-symlink file: {path}")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        metadata = os.fstat(fd)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or file_identity(metadata) != file_identity(before)
        ):
            raise FreezeError(f"lifecycle evidence input changed while opening: {path}")
        observed_size = metadata.st_size
        wanted = observed_size if byte_limit is None else byte_limit
        if wanted < 0 or wanted > observed_size:
            raise FreezeError(
                f"committed fence offset {wanted} exceeds raw lifecycle size {observed_size}"
            )
        if wanted > MAX_PUBLICATION_BYTES:
            raise FreezeError(
                f"lifecycle evidence input exceeds {MAX_PUBLICATION_BYTES} bytes"
            )
        chunks: list[bytes] = []
        remaining = wanted
        while remaining:
            chunk = os.read(fd, min(remaining, 1024 * 1024))
            if not chunk:
                raise FreezeError("lifecycle evidence input was truncated during read")
            chunks.append(chunk)
            remaining -= len(chunk)
        after = os.fstat(fd)
        if file_identity(after) != file_identity(metadata):
            raise FreezeError(f"lifecycle evidence input changed during read: {path}")
        current = os.lstat(path)
        if file_identity(current) != file_identity(metadata):
            raise FreezeError(f"lifecycle evidence input path changed during read: {path}")
        return b"".join(chunks), observed_size
    finally:
        os.close(fd)


def parse_commit_ack(path: Path, nonce: str, observer_pid: int) -> CommitAck:
    raw, _ = read_regular_file(path)
    if not raw.endswith(b"\n") or raw.count(b"\n") != 1:
        raise FreezeError("committed ACK must contain exactly one newline-terminated record")
    parts = raw[:-1].split(b"\t")
    if len(parts) != 9 or parts[0] != COMMIT_PREFIX:
        raise FreezeError("malformed committed ACK record")
    expected_fields = (
        b"nonce=",
        b"seq=",
        b"mono_ns=",
        b"phase=",
        b"observer_pid=",
        b"observer_tid=",
        b"request_seq=",
        b"fence_end_offset=",
    )
    values: list[bytes] = []
    for token, prefix in zip(parts[1:], expected_fields, strict=True):
        if not token.startswith(prefix) or token == prefix:
            raise FreezeError(
                f"committed ACK expected ordered field {prefix[:-1].decode('ascii')}"
            )
        values.append(token[len(prefix):])
    ack_nonce = values[0].decode("ascii", errors="strict")
    phase = values[3].decode("ascii", errors="strict")
    sequence = parse_positive_u64(values[1], "seq")
    mono_ns = parse_positive_u64(values[2], "mono_ns")
    ack_pid = parse_positive_u64(values[4], "observer_pid")
    observer_tid = parse_positive_u64(values[5], "observer_tid")
    request_sequence = parse_positive_u64(values[6], "request_seq")
    fence_end_offset = parse_positive_u64(values[7], "fence_end_offset")
    if ack_nonce != nonce:
        raise FreezeError("committed ACK nonce does not match the lifecycle nonce")
    if phase != "post-quiescence":
        raise FreezeError("committed ACK is not for post-quiescence")
    if ack_pid != observer_pid:
        raise FreezeError("committed ACK observer PID does not match the postmaster")
    if request_sequence != 2:
        raise FreezeError("committed ACK request sequence is not the final request")
    return CommitAck(
        raw=raw,
        sha256=hashlib.sha256(raw).hexdigest(),
        nonce=ack_nonce,
        sequence=sequence,
        mono_ns=mono_ns,
        phase=phase,
        observer_pid=ack_pid,
        observer_tid=observer_tid,
        request_sequence=request_sequence,
        fence_end_offset=fence_end_offset,
    )


def freeze(
    *,
    raw_log: Path,
    commit_ack: Path,
    output: Path,
    receipt: Path,
    nonce: str,
    observer_pid: int,
    phase_sequence: int,
    phase_mono_ns: int,
) -> None:
    resolved = [path.resolve() for path in (raw_log, commit_ack, output, receipt)]
    if len(set(resolved)) != len(resolved):
        raise FreezeError("raw, committed ACK, frozen output, and receipt paths must differ")
    for path in (raw_log, commit_ack, output, receipt):
        if "\t" in str(path) or "\n" in str(path):
            raise FreezeError("lifecycle evidence paths cannot contain tabs or newlines")
    output = Path(os.path.abspath(output))
    receipt = Path(os.path.abspath(receipt))
    if output.parent != receipt.parent:
        raise FreezeError("frozen output and receipt must share one publication directory")

    ack = parse_commit_ack(commit_ack, nonce, observer_pid)
    prefix, raw_observed_size = read_regular_file(
        raw_log, byte_limit=ack.fence_end_offset
    )
    fence = (
        "wasix-runtime-fence-v1"
        f"\tnonce={ack.nonce}\tseq={ack.sequence}\tmono_ns={ack.mono_ns}"
        f"\tphase={ack.phase}\tobserver_pid={ack.observer_pid}"
        f"\tobserver_tid={ack.observer_tid}\trequest_seq={ack.request_sequence}\n"
    ).encode("ascii")
    if not prefix.endswith(fence):
        raise FreezeError(
            "committed fence offset does not end at the matching runtime fence record"
        )
    if prefix.count(fence) != 1:
        raise FreezeError("committed runtime fence record is not unique in the frozen prefix")

    complete = (
        "wasix-runtime-phase-v1"
        f"\tnonce={nonce}\tseq={phase_sequence}\tmono_ns={phase_mono_ns}"
        f"\tphase=complete\tobserver_pid={observer_pid}\n"
    ).encode("ascii")
    frozen = prefix + complete
    digest = hashlib.sha256(frozen).hexdigest()

    # The ACK is a mutable rendezvous pathname. Re-open it only after the
    # output bytes have been rendered and require byte-for-byte identity with
    # the ACK that selected the prefix before either public name is admitted.
    confirmed_ack = parse_commit_ack(commit_ack, nonce, observer_pid)
    if confirmed_ack.raw != ack.raw or confirmed_ack.sha256 != ack.sha256:
        raise FreezeError("committed ACK changed while lifecycle evidence was frozen")

    receipt_payload = (
        "schema_version\traw_log\traw_observed_size\tcommit_ack\tcommit_ack_sha256"
        "\tfence_end_offset\tfrozen_log\tfrozen_size\tsha256\tnonce\tobserver_pid"
        "\tfence_sequence\tfence_mono_ns\tcomplete_phase_sequence"
        "\tcomplete_phase_mono_ns\n"
        "oliphaunt.wasix-postmaster.lifecycle-freeze.v2"
        f"\t{raw_log}\t{raw_observed_size}\t{commit_ack}\t{ack.sha256}"
        f"\t{ack.fence_end_offset}\t{output}\t{len(frozen)}\t{digest}"
        f"\t{nonce}\t{observer_pid}\t{ack.sequence}\t{ack.mono_ns}"
        f"\t{phase_sequence}\t{phase_mono_ns}\n"
    ).encode("utf-8")
    output.parent.mkdir(parents=True, exist_ok=True)
    token = f"{os.getpid()}.{secrets.token_hex(16)}"
    private_output = output.with_name(f".{output.name}.pending.{token}")
    private_receipt = receipt.with_name(f".{receipt.name}.pending.{token}")
    output_identity = write_bytes(private_output, frozen)
    receipt_identity = None
    try:
        receipt_identity = write_bytes(private_receipt, receipt_payload)
        publish_set(
            (private_output, output, private_receipt, receipt),
            (output_identity, receipt_identity),
        )
    finally:
        remove_private(private_output, output_identity)
        if receipt_identity is not None:
            remove_private(private_receipt, receipt_identity)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Freeze a WASIX lifecycle log through its committed writer fence"
    )
    parser.add_argument("--raw-log", required=True, type=Path)
    parser.add_argument("--commit-ack", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--nonce", required=True)
    parser.add_argument("--observer-pid", required=True, type=int)
    parser.add_argument("--complete-phase-sequence", required=True, type=int)
    parser.add_argument("--complete-phase-mono-ns", required=True, type=int)
    args = parser.parse_args()
    if not NONCE_RE.fullmatch(args.nonce):
        parser.error("--nonce must be exactly 32 lowercase hexadecimal characters")
    for option, value in (
        ("--observer-pid", args.observer_pid),
        ("--complete-phase-sequence", args.complete_phase_sequence),
        ("--complete-phase-mono-ns", args.complete_phase_mono_ns),
    ):
        if value <= 0 or value > U64_MAX:
            parser.error(f"{option} must be a positive u64")
    try:
        freeze(
            raw_log=args.raw_log,
            commit_ack=args.commit_ack,
            output=args.output,
            receipt=args.receipt,
            nonce=args.nonce,
            observer_pid=args.observer_pid,
            phase_sequence=args.complete_phase_sequence,
            phase_mono_ns=args.complete_phase_mono_ns,
        )
    except (FreezeError, OSError, PublicationError, UnicodeError) as error:
        print(f"could not freeze WASIX lifecycle evidence: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

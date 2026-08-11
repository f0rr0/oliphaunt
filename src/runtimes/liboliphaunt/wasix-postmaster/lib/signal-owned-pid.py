#!/usr/bin/env python3

from __future__ import annotations

import argparse
import ctypes
import errno
import os
from pathlib import Path
import re
import select
import signal
import sys


IDENTITY = re.compile(r"linux-starttime:([1-9][0-9]*)")


def process_starttime(pid: int) -> int | None:
    try:
        record = Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
    except (FileNotFoundError, ProcessLookupError):
        return None
    except OSError as error:
        raise RuntimeError(f"could not read /proc/{pid}/stat: {error}") from error
    closing = record.rfind(") ")
    if closing < 0:
        raise RuntimeError(f"malformed /proc/{pid}/stat")
    fields = record[closing + 2 :].split()
    if len(fields) < 20 or not fields[19].isdigit():
        raise RuntimeError(f"malformed starttime in /proc/{pid}/stat")
    return int(fields[19])


def parse_signal(value: str) -> int:
    normalized = value.removeprefix("SIG").upper()
    try:
        number = int(normalized)
    except ValueError:
        try:
            return int(signal.Signals[f"SIG{normalized}"])
        except KeyError as error:
            raise argparse.ArgumentTypeError(f"unsupported signal: {value}") from error
    try:
        return int(signal.Signals(number))
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"unsupported signal: {value}") from error


def pidfd_is_exited(pidfd: int) -> bool:
    poller = select.poll()
    poller.register(pidfd, select.POLLIN)
    return bool(poller.poll(0))


def signal_owned_pid(pid: int, expected_starttime: int, signum: int) -> int:
    libc = ctypes.CDLL(None, use_errno=True)
    if not hasattr(libc, "pidfd_open") or not hasattr(libc, "pidfd_send_signal"):
        print("libc does not expose Linux pidfd APIs", file=sys.stderr)
        return 125
    libc.pidfd_open.argtypes = (ctypes.c_int, ctypes.c_uint)
    libc.pidfd_open.restype = ctypes.c_int
    libc.pidfd_send_signal.argtypes = (
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_void_p,
        ctypes.c_uint,
    )
    libc.pidfd_send_signal.restype = ctypes.c_int

    pidfd = libc.pidfd_open(pid, 0)
    if pidfd < 0:
        error = ctypes.get_errno()
        if error == errno.ESRCH:
            return 0
        print(f"pidfd_open({pid}) failed: {os.strerror(error)}", file=sys.stderr)
        return 125
    try:
        try:
            actual_starttime = process_starttime(pid)
        except RuntimeError as error:
            if pidfd_is_exited(pidfd):
                return 0
            print(error, file=sys.stderr)
            return 125
        if actual_starttime is None:
            return 0 if pidfd_is_exited(pidfd) else 125
        if actual_starttime != expected_starttime:
            if pidfd_is_exited(pidfd):
                return 0
            print(
                "refusing to signal reused process identity: "
                f"pid={pid} expected=linux-starttime:{expected_starttime} "
                f"actual=linux-starttime:{actual_starttime}",
                file=sys.stderr,
            )
            return 125
        if libc.pidfd_send_signal(pidfd, signum, None, 0) < 0:
            error = ctypes.get_errno()
            if error == errno.ESRCH:
                return 0
            print(f"pidfd_send_signal({pid}) failed: {os.strerror(error)}", file=sys.stderr)
            return 125
        return 0
    finally:
        os.close(pidfd)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--identity", required=True)
    parser.add_argument("--signal", type=parse_signal, required=True)
    args = parser.parse_args()
    if args.pid <= 0:
        parser.error("--pid must be positive")
    match = IDENTITY.fullmatch(args.identity)
    if match is None:
        parser.error("--identity must be linux-starttime:<positive integer>")
    return signal_owned_pid(args.pid, int(match.group(1)), args.signal)


if __name__ == "__main__":
    raise SystemExit(main())

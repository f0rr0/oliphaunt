#!/usr/bin/env python3
"""Run a command while holding the shared native runtime test lock."""

from __future__ import annotations

import errno
import os
from pathlib import Path
import subprocess
import sys
import time

if os.name == "nt":
    import msvcrt
else:
    import fcntl


DEFAULT_TIMEOUT_SECONDS = 30 * 60


def repo_root() -> Path:
    try:
        output = subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"],
            stderr=subprocess.DEVNULL,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return Path.cwd()
    return Path(output.strip())


def lock_path() -> Path:
    configured = os.environ.get("OLIPHAUNT_NATIVE_RUNTIME_LOCK_FILE")
    if configured:
        return Path(configured)
    return repo_root() / "target" / "oliphaunt-runtime-locks" / "native-runtime-tests.lock"


def timeout_seconds() -> float:
    configured = os.environ.get("OLIPHAUNT_NATIVE_RUNTIME_LOCK_TIMEOUT_SECONDS")
    if not configured:
        return float(DEFAULT_TIMEOUT_SECONDS)
    try:
        timeout = float(configured)
    except ValueError:
        raise SystemExit(
            "OLIPHAUNT_NATIVE_RUNTIME_LOCK_TIMEOUT_SECONDS must be a number"
        ) from None
    if timeout <= 0:
        raise SystemExit(
            "OLIPHAUNT_NATIVE_RUNTIME_LOCK_TIMEOUT_SECONDS must be greater than zero"
        )
    return timeout


def open_lock_file(lock_file: Path):
    lock_file.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_file.open("a+b")
    if os.name == "nt":
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
    return handle


def try_lock(handle) -> None:
    if os.name == "nt":
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def unlock(handle) -> None:
    if os.name == "nt":
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def is_lock_contention(error: OSError) -> bool:
    if os.name == "nt":
        return error.errno in {
            errno.EACCES,
            getattr(errno, "EDEADLK", errno.EACCES),
            errno.EAGAIN,
        }
    return error.errno in {errno.EACCES, errno.EAGAIN}


def acquire_lock(lock_file: Path, timeout: float):
    handle = open_lock_file(lock_file)
    deadline = time.monotonic() + timeout
    last_notice = 0.0

    while True:
        try:
            try_lock(handle)
            break
        except OSError as error:
            if not is_lock_contention(error):
                handle.close()
                raise
            now = time.monotonic()
            if now >= deadline:
                handle.close()
                raise TimeoutError(
                    f"timed out waiting for native runtime test lock after {timeout:.0f}s: {lock_file}"
                ) from error
            if now - last_notice >= 30:
                print(
                    f"waiting for native runtime test lock: {lock_file}",
                    file=sys.stderr,
                    flush=True,
                )
                last_notice = now
            time.sleep(0.25)

    handle.seek(0)
    handle.truncate()
    metadata = (
        f"pid={os.getpid()}\n"
        f"cwd={Path.cwd()}\n"
        f"started_at_unix={int(time.time())}\n"
        f"command={' '.join(sys.argv[1:])}\n"
    )
    handle.write(metadata.encode("utf-8"))
    handle.flush()
    return handle


def main() -> int:
    if len(sys.argv) < 2:
        print(
            "usage: tools/runtime/with-native-runtime-lock.py <command> [args...]",
            file=sys.stderr,
        )
        return 2

    path = lock_path()
    try:
        handle = acquire_lock(path, timeout_seconds())
    except TimeoutError as error:
        print(error, file=sys.stderr)
        return 124

    try:
        completed = subprocess.run(sys.argv[1:], check=False)
    finally:
        unlock(handle)
        handle.close()
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())

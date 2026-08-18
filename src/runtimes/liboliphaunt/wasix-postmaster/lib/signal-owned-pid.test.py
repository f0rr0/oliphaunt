#!/usr/bin/env python3

from __future__ import annotations

from contextlib import redirect_stderr
import importlib.util
import io
from pathlib import Path
import subprocess
import sys
import time
import unittest
from unittest import mock


SCRIPT = Path(__file__).with_name("signal-owned-pid.py")


def load_helper():
    spec = importlib.util.spec_from_file_location("signal_owned_pid", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HELPER = load_helper()


class FakeCFunction:
    def __init__(self, implementation):
        self.implementation = implementation
        self.argtypes = None
        self.restype = None

    def __call__(self, *args):
        return self.implementation(*args)


class FakeLibc:
    def __init__(self, pidfd_open, pidfd_send_signal):
        self.pidfd_open = FakeCFunction(pidfd_open)
        self.pidfd_send_signal = FakeCFunction(pidfd_send_signal)


def starttime(pid: int) -> int:
    record = Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
    fields = record[record.rfind(") ") + 2 :].split()
    return int(fields[19])


class SignalOwnedPidTests(unittest.TestCase):
    def test_pidfd_is_opened_before_identity_is_read_and_signal_uses_that_fd(
        self,
    ) -> None:
        events: list[tuple[object, ...]] = []

        def pidfd_open(pid: int, flags: int) -> int:
            events.append(("open", pid, flags))
            return 71

        def read_starttime(pid: int) -> int:
            events.append(("read-starttime", pid))
            return 303

        def pidfd_send_signal(
            pidfd: int, signum: int, siginfo: object, flags: int
        ) -> int:
            events.append(("send", pidfd, signum, siginfo, flags))
            return 0

        libc = FakeLibc(pidfd_open, pidfd_send_signal)
        with (
            mock.patch.object(HELPER.ctypes, "CDLL", return_value=libc),
            mock.patch.object(HELPER, "process_starttime", side_effect=read_starttime),
            mock.patch.object(
                HELPER,
                "pidfd_is_exited",
                side_effect=AssertionError("matching identity must not poll the pidfd"),
            ),
            mock.patch.object(
                HELPER.os,
                "close",
                side_effect=lambda fd: events.append(("close", fd)),
            ),
        ):
            status = HELPER.signal_owned_pid(41, 303, 15)

        self.assertEqual(status, 0)
        self.assertEqual(
            events,
            [
                ("open", 41, 0),
                ("read-starttime", 41),
                ("send", 71, 15, None, 0),
                ("close", 71),
            ],
        )

    def test_live_pidfd_rejects_starttime_mismatch_without_signalling(self) -> None:
        events: list[tuple[object, ...]] = []
        libc = FakeLibc(
            lambda pid, flags: events.append(("open", pid, flags)) or 72,
            lambda *args: events.append(("send", *args)) or 0,
        )
        stderr = io.StringIO()
        with (
            mock.patch.object(HELPER.ctypes, "CDLL", return_value=libc),
            mock.patch.object(HELPER, "process_starttime", return_value=404),
            mock.patch.object(
                HELPER,
                "pidfd_is_exited",
                side_effect=lambda fd: events.append(("poll", fd)) or False,
            ),
            mock.patch.object(
                HELPER.os,
                "close",
                side_effect=lambda fd: events.append(("close", fd)),
            ),
            redirect_stderr(stderr),
        ):
            status = HELPER.signal_owned_pid(42, 303, 15)

        self.assertEqual(status, 125)
        self.assertEqual(events, [("open", 42, 0), ("poll", 72), ("close", 72)])
        self.assertIn(
            "pid=42 expected=linux-starttime:303 actual=linux-starttime:404",
            stderr.getvalue(),
        )

    def test_exited_pidfd_turns_starttime_mismatch_into_noop(self) -> None:
        events: list[tuple[object, ...]] = []
        libc = FakeLibc(
            lambda pid, flags: events.append(("open", pid, flags)) or 73,
            lambda *args: events.append(("send", *args)) or 0,
        )
        with (
            mock.patch.object(HELPER.ctypes, "CDLL", return_value=libc),
            mock.patch.object(HELPER, "process_starttime", return_value=404),
            mock.patch.object(
                HELPER,
                "pidfd_is_exited",
                side_effect=lambda fd: events.append(("poll", fd)) or True,
            ),
            mock.patch.object(
                HELPER.os,
                "close",
                side_effect=lambda fd: events.append(("close", fd)),
            ),
        ):
            status = HELPER.signal_owned_pid(43, 303, 15)

        self.assertEqual(status, 0)
        self.assertEqual(events, [("open", 43, 0), ("poll", 73), ("close", 73)])

    def test_proc_disappearance_is_accepted_only_after_pidfd_exit(self) -> None:
        for pidfd_exited, expected_status in ((False, 125), (True, 0)):
            with self.subTest(pidfd_exited=pidfd_exited):
                events: list[tuple[object, ...]] = []
                libc = FakeLibc(
                    lambda pid, flags: events.append(("open", pid, flags)) or 74,
                    lambda *args: events.append(("send", *args)) or 0,
                )
                with (
                    mock.patch.object(HELPER.ctypes, "CDLL", return_value=libc),
                    mock.patch.object(HELPER, "process_starttime", return_value=None),
                    mock.patch.object(
                        HELPER,
                        "pidfd_is_exited",
                        side_effect=lambda fd: events.append(("poll", fd))
                        or pidfd_exited,
                    ),
                    mock.patch.object(
                        HELPER.os,
                        "close",
                        side_effect=lambda fd: events.append(("close", fd)),
                    ),
                ):
                    status = HELPER.signal_owned_pid(44, 303, 15)

                self.assertEqual(status, expected_status)
                self.assertEqual(
                    events, [("open", 44, 0), ("poll", 74), ("close", 74)]
                )

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux pidfd contract")
    def test_pidfd_rejects_wrong_birth_and_signals_exact_process(self) -> None:
        process = subprocess.Popen(["sleep", "30"])
        try:
            identity = f"linux-starttime:{starttime(process.pid)}"
            wrong = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--pid",
                    str(process.pid),
                    "--identity",
                    "linux-starttime:1",
                    "--signal",
                    "TERM",
                ],
                check=False,
                text=True,
                capture_output=True,
            )
            self.assertEqual(wrong.returncode, 125, wrong.stderr)
            self.assertIsNone(process.poll())

            sent = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--pid",
                    str(process.pid),
                    "--identity",
                    identity,
                    "--signal",
                    "TERM",
                ],
                check=False,
                text=True,
                capture_output=True,
            )
            self.assertEqual(sent.returncode, 0, sent.stderr)
            process.wait(timeout=2)
            self.assertEqual(process.returncode, -15)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux pidfd contract")
    def test_already_exited_process_is_a_noop(self) -> None:
        # Keep the fixture alive long enough to capture a real birth identity,
        # then reap it before invoking the helper.  A `true` process can exit
        # before /proc is read and makes this race test the fixture, not pidfd.
        process = subprocess.Popen(["sleep", "30"])
        identity = f"linux-starttime:{starttime(process.pid)}"
        process.terminate()
        process.wait(timeout=2)
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--pid",
                str(process.pid),
                "--identity",
                identity,
                "--signal",
                "TERM",
            ],
            check=False,
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()

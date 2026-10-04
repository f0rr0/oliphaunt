#!/usr/bin/env python3
"""Run every capability in a bounded child process; preserve crashes and logs."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import time

CORE = [
    "basic", "guest-eh", "cross-module-eh", "uncaught-eh", "host-error", "host-error-dynamic",
    "contained-host-panic", "contained-host-panic-dynamic",
    "host-error-identity", "host-error-identity-dynamic",
    "shared-memory", "shared-memory-thread", "stack-overflow", "eh-stack-overflow",
    "cache-write", "cache-read", "cache-header-compatibility", "module-thread",
]
DIAGNOSTICS = ["host-panic", "host-panic-dynamic", "host-exception", "host-atomics", "uncaught-eh-metadata"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--output", type=Path, default=Path("results"))
    parser.add_argument("--wasix", action="store_true")
    parser.add_argument("--postgres-module", type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    evidence = {
        "sha": os.getenv("GITHUB_SHA"),
        "run_id": os.getenv("GITHUB_RUN_ID"),
        "runner_os": os.getenv("RUNNER_OS"),
        "runner_image": os.getenv("ImageVersion"),
        "platform": platform.platform(),
        "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "binary_bytes": binary.stat().st_size,
        "wasmer": "7.5.0",
        "wasix": "0.705.0" if args.wasix else None,
        "cases": [],
    }
    guest = args.postgres_module.resolve() if args.postgres_module else None
    if guest:
        evidence["postgres_module"] = {"sha256": hashlib.sha256(guest.read_bytes()).hexdigest(),
                                       "bytes": guest.stat().st_size}
    artifact_root = binary.parent.parent / "wee8-artifacts"
    evidence["v8_distribution"] = [
        {"path": str(path.relative_to(artifact_root)), "bytes": path.stat().st_size,
         "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        for path in artifact_root.rglob("*")
        if path.is_file() and path.name.endswith((".tar.xz", ".zip"))
    ]
    send_status = output / "store-send-exit-code.txt"
    if send_status.exists():
        evidence["v8_only_store_send_check_exit_code"] = int(send_status.read_text().strip())
    required = CORE + (["wasix", "blocking-io", "directory-io", "wasi-exit"] if args.wasix else []) + (["postgres-module"] if guest else [])
    for case in required + DIAGNOSTICS + (["async-call"] if args.wasix else []):
        start = time.monotonic()
        try:
            if case == "cache-read" and evidence["cases"][-1]["status"] != "pass":
                raise RuntimeError("cache-write failed; do not consume a stale cache")
            result = subprocess.run(
                [str(binary), case] + ([str(guest)] if case == "postgres-module" else []), cwd=output, capture_output=True,
                timeout=45, env={**os.environ, "RUST_BACKTRACE": "1"},
            )
            code = result.returncode
            log = result.stdout + result.stderr
            status = "pass" if code == 0 else "fail"
        except subprocess.TimeoutExpired as exc:
            code = None
            log = (exc.stdout or b"") + (exc.stderr or b"")
            status = "timeout"
        except RuntimeError as exc:
            code = None
            log = str(exc).encode()
            status = "blocked"
        (output / f"{case}.log").write_bytes(log)
        record = {
            "case": case, "required": case in required, "status": status,
            "exit_code": code, "elapsed_seconds": time.monotonic() - start,
        }
        evidence["cases"].append(record)
        print(json.dumps(record), flush=True)
        # Save incrementally so a job-level failure retains completed evidence.
        (output / "results.json").write_text(json.dumps(evidence, indent=2) + "\n")
    failed = [r["case"] for r in evidence["cases"] if r["required"] and r["status"] != "pass"]
    print(f"Required failures: {', '.join(failed) or 'none'}", flush=True)
    return bool(failed)


if __name__ == "__main__":
    raise SystemExit(main())

"""Exercise automatic WASIX interruption, late attachment and teardown races."""
import hashlib
import json
import pathlib
import re
import subprocess
import sys


def check_log(text, fallible=False):
    late = "ERROR task_attach=ERROR" if fallible else "REJECTED"
    cycles = re.findall(r"^automatic_interrupt_cycle=(\d+) workers=(\d+) elapsed_ms=(\[[\d, ]+\]) late_attach="
                        + late + r" late_signals=PASS$", text, re.M)
    assert len(cycles) == text.count("automatic_interrupt_cycle=") == 25, "incomplete wait cycles"
    assert [int(row[0]) for row in cycles] == list(range(1, 26)), "duplicate or missing wait cycle"
    for index, workers, elapsed in cycles:
        workers = int(workers)
        assert workers == (1 if int(index) <= 20 else 3), "wrong waiter count"
        elapsed = json.loads(elapsed)
        assert len(elapsed) == workers and all(0 <= ms < 3000 for ms in elapsed), "slow or missing waiter"
    teardown = re.findall(r"^automatic_teardown_race=(\d+) stores=9 interrupts=101 result=PASS$", text, re.M)
    assert len(teardown) == text.count("automatic_teardown_race=") == 32, "incomplete teardown races"
    assert list(map(int, teardown)) == list(range(1, 33)), "duplicate or missing teardown race"
    counts = {"wait_cycles": len(cycles), "waiters": sum(int(row[1]) for row in cycles),
              "late_attach_rejections": len(cycles), "post_teardown_signals": 2500,
              "teardown_races": len(teardown), "race_stores": len(teardown) * 9}
    if fallible:
        assert "panicked at" not in text, "fallible attachment unexpectedly panicked"
        attachments = re.findall(r"^attachment_teardown_race=(\d+) attempts=8 rejected=(\d+) result=PASS$", text, re.M)
        assert len(attachments) == text.count("attachment_teardown_race=") == 32, "incomplete attachment races"
        assert [int(row[0]) for row in attachments] == list(range(1, 33)), "duplicate or missing attachment race"
        assert all(0 <= int(row[1]) <= 8 for row in attachments), "invalid attachment rejection count"
        counts.update(late_attach_errors=25, task_attach_errors=25,
                      attachment_races=len(attachments), race_attachments=len(attachments) * 8)
    summary = re.findall(r"^automatic_store_interrupt=PASS (.+)$", text, re.M)
    assert len(summary) == text.count("automatic_store_interrupt=") == 1, "missing or duplicate summary"
    assert summary[0] == " ".join(f"{key}={value}" for key, value in counts.items()), "summary differs from cycles"
    return counts


def main():
    assert len(sys.argv) == 2 or (len(sys.argv) == 3 and sys.argv[2] == "--fallible")
    fallible = len(sys.argv) == 3
    output = pathlib.Path(sys.argv[1]).resolve()
    command = ["cargo", "test", "--locked", "-p", "oliphaunt-wasix", "--no-default-features",
               "--test", "research_v8_automatic_interrupt", "--no-run", "--message-format=json"]
    build = subprocess.run(command, capture_output=True, encoding="utf-8", timeout=1200)
    (output / "automatic-interrupt-build.log").write_text(build.stdout + build.stderr)
    if build.returncode:
        print(build.stderr[-16000:], flush=True)
        sys.exit(build.returncode)
    executables = [json.loads(line)["executable"] for line in build.stdout.splitlines()
                   if line.startswith("{") and json.loads(line).get("reason") == "compiler-artifact"
                   and json.loads(line).get("executable")]
    assert len(executables) == 1, executables
    executable = pathlib.Path(executables[0])
    with (output / "automatic-interrupt.log").open("w") as log:
        result = subprocess.run([str(executable), "--nocapture", "--test-threads=1"],
                                stdout=log, stderr=subprocess.STDOUT, timeout=120)
    text = (output / "automatic-interrupt.log").read_text(errors="replace")
    print(text, flush=True)
    assert result.returncode == 0, result.returncode
    receipt = {
        "scope": "existing WASIX and memory APIs with automatic lifetime hooks; not installed carriers",
        "exit_code": result.returncode,
        "executable_sha256": hashlib.sha256(executable.read_bytes()).hexdigest(),
        **check_log(text, fallible), "manual_capture_or_retirement": False,
    }
    (output / "automatic-interrupt-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    if fallible:
        receipt.update(wasix_task_attachment_errors=receipt["task_attach_errors"], expected_attachment_panics=0)
        (output / "fallible-attachment-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    main()

"""Trusted same-run cache exchange; preserve V8's native compatibility checks."""
import argparse
import json
import pathlib
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("binary")
parser.add_argument("output", type=pathlib.Path)
parser.add_argument("--postgres")
parser.add_argument("--peers", type=pathlib.Path)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)


def run(mode, operation, path, expect_success=True, postgres=None):
    command = [args.binary, "cpu-profile", mode, operation, str(path)]
    if postgres:
        command.append(postgres)
    result = subprocess.run(command, capture_output=True, text=True, timeout=180)
    log = result.stdout + result.stderr
    print(log, end="", flush=True)
    (args.output / f"{mode}-{operation}-{path.parent.name}-{path.name}.log").write_text(log)
    if (result.returncode == 0) != expect_success:
        raise RuntimeError(f"unexpected exit {result.returncode}: {command}")
    if not expect_success and "Failed to deserialize V8 module" not in log:
        raise RuntimeError(f"expected V8 compatibility rejection: {command}")


for profile in ("default", "baseline"):
    path = args.output / f"{profile}.cache"
    run(profile, "write", path, postgres=args.postgres)
    run(profile, "read", path)

# Flag hashes differ even on hosts whose ISA masks might coincide.
run("default", "read", args.output / "baseline.cache", expect_success=False)
run("baseline", "read", args.output / "default.cache", expect_success=False)
if args.peers:
    own_header = json.loads((args.output / "baseline.cache.header").read_text())
    for peer in sorted(args.peers.rglob("baseline.cache")):
        peer_header = json.loads(pathlib.Path(f"{peer}.header").read_text())
        expected = own_header == peer_header
        print(f"peer={peer.parent.name} expected_compatible={expected}", flush=True)
        run("baseline", "read", peer, expect_success=expected)
print("PASS CPU profile validation", flush=True)

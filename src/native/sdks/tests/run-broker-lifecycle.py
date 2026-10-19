"""Run installed BrokerApp consumers on a booted iOS simulator or Android emulator.
Build/install instructions live beside the test apps. This kills only their processes.
"""
import argparse
import os
from pathlib import Path
import re
import signal
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument("platform", choices=["ios", "android"])
parser.add_argument("device")
parser.add_argument("mode", choices=["smoke", "worker-death", "host-death", "backup-death", "restore-death", "open-death", "recover", "deadline", "background"])
parser.add_argument("--adb", default=str(Path.home() / "Library/Android/sdk/platform-tools/adb"))
parser.add_argument("--output", type=Path, default=Path("target/broker-lifecycle/reports"))
args = parser.parse_args()
pkg = "dev.oliphaunt.brokertest"

def command(*words, check=True):
    return subprocess.run(words, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=check).stdout.strip()

def adb(*words, **kwargs):
    return command(args.adb, "-s", args.device, *words, **kwargs)

def sim(*words, **kwargs):
    return command("xcrun", "simctl", *words, **kwargs)

if args.platform == "ios":
    sim("terminate", args.device, pkg, check=False)
    worker_binary = sim("get_app_container", args.device, pkg, "app") + "/Extensions/OliphauntBroker.appex/OliphauntBroker"
    result = Path(sim("get_app_container", args.device, pkg, "data")) / "Documents/broker-result.txt"
    result.unlink(missing_ok=True)
else:
    adb("shell", "am", "force-stop", pkg)
    adb("shell", "run-as", pkg, "rm", "-f", "files/broker-result.txt")

def worker_pids():
    if args.platform == "android":
        return [int(p) for p in adb("shell", "pidof", pkg + ":oliphaunt", check=False).split()]
    processes = command("ps", "-axo", "pid=,command=").splitlines()
    return [int(line.split()[0]) for line in processes if worker_binary in line]

def kill(pid):
    if args.platform == "ios":
        os.kill(pid, signal.SIGKILL)
    else:
        adb("shell", "run-as", pkg, "kill", "-9", str(pid))

def launch(mode):
    if args.platform == "ios":
        sim("launch", args.device, pkg, mode)
    else:
        adb("shell", "am", "start", "-n", pkg + "/.MainActivity", "--es", "mode", mode)

# Wait for the preceding app's worker to retire before targeting a new launch.
for _ in range(100):
    if not worker_pids():
        break
    time.sleep(0.05)
else:
    raise RuntimeError("previous worker did not retire")
if args.mode in ("open-death", "restore-death"):
    staging_pattern = ".*-restore-staging-*" if args.mode == "restore-death" else ".oliphaunt-root-*"
    if args.platform == "ios":
        smoke = (args.output / "ios-smoke.log").read_text()
        storage_root = Path(re.search(r"PGDATA (.+)", smoke).group(1)).parent.parent
        initial_staging = set(storage_root.glob(staging_pattern))
    else:
        initial_staging = set(adb("shell", "run-as", pkg, "ls", "-a", "no_backup/Oliphaunt").splitlines())
launch(args.mode)
killed = False
backgrounded = False
output = ""
events = []
deadline = time.monotonic() + 180
while time.monotonic() < deadline:
    if args.mode in ("open-death", "restore-death") and not killed:
        transfer_started = True
        if args.mode in ("open-death", "restore-death"):
            if args.platform == "ios":
                current = set(storage_root.glob(staging_pattern))
            else:
                current = set(adb("shell", "run-as", pkg, "ls", "-a", "no_backup/Oliphaunt").splitlines())
                current = {name for name in current if ("-restore-staging-" in name if args.mode == "restore-death" else name.startswith(".oliphaunt-root-"))}
            transfer_started = bool(current - initial_staging)
        for pid in worker_pids() if transfer_started else []:
            kill(pid)
            killed = True
            events.append(f"Killed new worker {pid}" + (" after restore staging began" if args.mode == "restore-death" else " during fresh-root preparation"))
            print(events[-1], flush=True)
    if args.platform == "ios":
        output = result.read_text() if result.exists() else ""
    else:
        output = adb("shell", "run-as", pkg, "cat", "files/broker-result.txt", check=False)
    if args.mode == "background" and "BACKGROUND_NOW" in output and not backgrounded:
        if args.platform == "ios":
            sim("launch", args.device, "com.apple.mobilesafari")
        else:
            adb("shell", "input", "keyevent", "KEYCODE_HOME")
        time.sleep(2)
        launch("background")
        backgrounded = True
        events.append("Backgrounded for 2 seconds, then foregrounded")
    if args.mode == "host-death" and "KILL_HOST_NOW" in output and not killed:
        pid = int(re.search(r"HOST (\d+)", output).group(1))
        kill(pid)
        killed = True
        events.append(f"Killed host {pid}")
        print(events[-1], flush=True)
        time.sleep(1)
        launch("recover")
    if "FAIL:" in output or output.rstrip().endswith("PASS"):
        break
    time.sleep(0.02 if args.platform == "ios" else 0.05)
args.output.mkdir(parents=True, exist_ok=True)
(args.output / f"{args.platform}-{args.mode}.log").write_text("\n".join(events + [output]) + "\n")
print(output)
assert output.rstrip().endswith("PASS"), "installed lifecycle test failed or timed out"
if args.mode in ("host-death", "open-death", "restore-death"):
    assert killed, "test did not inject process death"

if args.mode == "background":
    assert backgrounded, "test did not background the app"

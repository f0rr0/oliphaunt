"""Native audit of exact retained DLL controls; never shipping qualification."""
import ast
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys

output = pathlib.Path(sys.argv[1]).resolve()
receipt = json.loads((output / "receipt.json").read_text())
dll = output / "oliphaunt_wee8.dll"
assert hashlib.sha256(dll.read_bytes()).hexdigest() == receipt["hashes"]["dll"]
bindings = output / "dependency/wasmer-7.5.0/prebuilt/v8_bindings.rs"
assert hashlib.sha256(bindings.read_bytes()).hexdigest() == receipt["hashes"]["bindings"]

# Execute the actual fixed tool-location statement from the consumer script.
# This does not replay compilation or stage a different producer DLL.
source = pathlib.Path(__file__).with_name("dll_consumer_check.py")
statement = next(node for node in ast.parse(source.read_text()).body
                 if isinstance(node, ast.Assign)
                 and any(isinstance(t, ast.Name) and t.id == "dumpbin" for t in node.targets))
scope = {"pathlib": pathlib, "os": os, "env": os.environ.copy()}
exec(compile(ast.Module(body=[statement], type_ignores=[]), str(source), "exec"), scope)
dumpbin = scope["dumpbin"]
assert dumpbin.is_file(), dumpbin
results = {}
for argument, target, name in [
        ("/EXPORTS", dll, "exports"),
        ("/DEPENDENTS", dll, "dependencies"),
        ("/LINKERMEMBER:2", output / "oliphaunt_wee8.lib", "imports")]:
    process = subprocess.run([str(dumpbin), "/NOLOGO", argument, str(target)],
                             capture_output=True, text=True, check=True)
    results[name] = process.stdout
    (output / f"native-audit-{name}.log").write_text(process.stdout + process.stderr)
required = re.findall(r'^\s+(wee8_\w+|research_set_v8_flags)\s*$',
                      (output / "imports.def").read_text(), re.M)
assert len(required) == 311
assert all(name in results["exports"] and name in results["imports"] for name in required)
assert "?" not in results["imports"], "C++ imports present in restricted consumer library"
for name in ["WINMM.dll", "dbghelp.dll", "KERNEL32.dll", "ADVAPI32.dll"]:
    assert name.lower() in results["dependencies"].lower()
audit = {"scope": __doc__, "producer": receipt, "dumpbin": str(dumpbin),
         "sourceSha": os.environ["GITHUB_SHA"], "runId": os.environ["GITHUB_RUN_ID"],
         "verifiedCImports": len(required), "retainedProducerRun": "37277151739"}
(output / "native-audit-receipt.json").write_text(json.dumps(audit, indent=2) + "\n")
print("PASS fixed native Windows DLL audit; 311 C imports; retained producer hashes match")

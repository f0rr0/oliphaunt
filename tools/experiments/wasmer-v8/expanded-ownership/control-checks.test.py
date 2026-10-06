"""Offline regressions for the native lifetime qualification drivers."""
import pathlib
import runpy
import unittest

drivers = pathlib.Path(__file__).resolve().parent
check_log = runpy.run_path(str(drivers / "automatic-interrupt-check.py"))["check_log"]
fixture_source = runpy.run_path(str(drivers / "fallible-attachment.py"))["fixture_source"]
render = runpy.run_path(str(drivers / "embed-dll.py"))["render"]
check_lock = runpy.run_path(str(drivers / "consumer-lock.py"))["check_lock"]


def log(fallible):
    late = "ERROR task_attach=ERROR" if fallible else "REJECTED"
    lines = [f"automatic_interrupt_cycle={index} workers={workers} elapsed_ms={[250] * workers} "
             f"late_attach={late} late_signals=PASS"
             for index in range(1, 26) for workers in [1 if index <= 20 else 3]]
    lines += [f"automatic_teardown_race={index} stores=9 interrupts=101 result=PASS"
              for index in range(1, 33)]
    if fallible:
        lines += [f"attachment_teardown_race={index} attempts=8 rejected={index % 9} result=PASS"
                  for index in range(1, 33)]
    lines += ["automatic_store_interrupt=PASS wait_cycles=25 waiters=35 late_attach_rejections=25 "
              "post_teardown_signals=2500 teardown_races=32 race_stores=288" +
              (" late_attach_errors=25 task_attach_errors=25 attachment_races=32 race_attachments=256"
               if fallible else "")]
    return "\n".join(lines) + "\n"


class ControlChecks(unittest.TestCase):
    def test_consumer_lock_allows_only_declared_producer_pruning(self):
        before = b'''[[package]]
name="sdk"
version="1.0.0"
dependencies=["wasmer","tempfile"]
[[package]]
name="wasmer"
version="7.5.0"
source="registry+immutable"
checksum="wasmer"
dependencies=["bindgen","runtime"]
[[package]]
name="bindgen"
version="1.0.0"
source="registry+immutable"
checksum="bindgen"
dependencies=["clang"]
[[package]]
name="clang"
version="1.0.0"
source="registry+immutable"
checksum="clang"
[[package]]
name="runtime"
version="1.0.0"
source="registry+immutable"
checksum="runtime"
[[package]]
name="tempfile"
version="3.0.0"
source="registry+immutable"
checksum="tempfile"
'''
        after = before.replace(b'source="registry+immutable"\nchecksum="wasmer"\n', b'')
        after = after.replace(b'dependencies=["bindgen","runtime"]', b'dependencies=["runtime"]')
        begin = after.index(b'[[package]]\nname="bindgen"')
        end = after.index(b'[[package]]\nname="runtime"')
        after = after[:begin] + after[end:]
        check_lock(before, after, removed={"bindgen"})
        with self.assertRaises(AssertionError):
            check_lock(before, after)
        with self.assertRaises(AssertionError):
            check_lock(before, after.replace(b'checksum="runtime"', b'checksum="changed"'), removed={"bindgen"})
        added = after.replace(b'dependencies=["runtime"]', b'dependencies=["runtime","tempfile"]')
        check_lock(after, added, added={"tempfile"})

    def test_dispatch_resolves_all_used_entries_before_rust_calls(self):
        unsupported = ["wasm_tag_get", "wasm_tag_set", "wasm_tagtype_as_externtype",
                       "wasm_tagtype_as_externtype_const"]
        names = unsupported + [f"wasm_control_{index}" for index in range(310)]
        bindings = "\n".join('unsafe extern "C" { #[link_name = "\\u{1}wee8_' + name +
            '"] pub fn ' + name + '(callback: Option<unsafe extern "C" fn(i32, i64) -> i32>, value: i32) -> i32; }'
            for name in names)
        generated, symbols, omitted = render(bindings, "a" * 64)
        self.assertEqual(len(symbols), 313)
        self.assertEqual(len(omitted), 4)
        self.assertNotIn('pub unsafe extern "C" fn', generated)
        self.assertIn('unsafe { function(callback, value) }', generated)
        self.assertIn('research_embedded_engine::symbol(312)', generated)
        self.assertNotIn('fn wasm_tag_get', generated)
        self.assertIn('b"wee8_wasm_control_0\\0"', generated)
        with self.assertRaises(AssertionError):
            render(bindings.replace('wee8_wasm_control_0', 'changed'), "a" * 64)

    def test_complete_evidence_and_summary_only(self):
        for fallible in (False, True):
            text = log(fallible)
            counts = check_log(text, fallible)
            self.assertEqual(counts["waiters"], 35)
            self.assertEqual(counts["race_stores"], 288)
            with self.assertRaises(AssertionError):
                check_log(text.splitlines()[-1] + "\n", fallible)

    def test_rejects_incomplete_or_inconsistent_evidence(self):
        text = log(True)
        corruptions = [
            text.replace("automatic_interrupt_cycle=2 ", "automatic_interrupt_cycle=1 "),
            text.replace("workers=3 ", "workers=1 ", 1),
            text.replace("elapsed_ms=[250]", "elapsed_ms=[3000]", 1),
            text.replace("automatic_teardown_race=32", "automatic_teardown_race=31"),
            text.replace("attachment_teardown_race=32", "attachment_teardown_race=31"),
            text.replace("attempts=8", "attempts=7", 1),
            text.replace("rejected=1", "rejected=9", 1),
            text.replace("waiters=35", "waiters=34"),
            text + text.splitlines()[-1] + "\n",
            text + "thread 'attachment' panicked at unexpected error\n",
        ]
        for corrupted in corruptions:
            with self.subTest(corrupted=corrupted[-160:]), self.assertRaises(AssertionError):
                check_log(corrupted, True)

    def test_fixture_drift_fails_before_build(self):
        source = (drivers / "automatic-interrupt.rs").read_text()
        fixture_source(source)
        for anchor in ("fn main() {", "late_attach=REJECTED", "panic::AssertUnwindSafe, ",
                       "teardown_race(&engine, index);", "teardown_races=32 race_stores=288"):
            with self.subTest(anchor=anchor), self.assertRaises(AssertionError):
                fixture_source(source.replace(anchor, "changed fixture"))


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).with_name("verify-runtime-state-ownership.py")


def load_verifier():
    spec = importlib.util.spec_from_file_location("runtime_state_ownership_verifier", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load verifier: {SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


VERIFIER = load_verifier()


STATE_MOD = r'''
use std::sync::Arc;

pub(crate) struct WasiState {
    runtime_state_registration: Option<WasiRuntimeStateRegistration>,
}

impl WasiState {
    #[cfg(feature = "enable-serde")]
    pub(crate) fn unfreeze(
        bytes: &[u8],
        control_plane: &WasiControlPlane,
    ) -> Option<Arc<Self>> {
        let state = bincode::deserialize(bytes).ok()?;
        Some(control_plane.register_runtime_state(state))
    }

    pub(crate) fn fork_registered(
        &self,
        control_plane: &WasiControlPlane,
        prepare: impl FnOnce(&mut Self),
    ) -> Result<Arc<Self>, Errno> {
        let mut state = self.fork()?;
        prepare(&mut state);
        Ok(control_plane.register_runtime_state(state))
    }

    fn fork(&self) -> Result<Self, Errno> {
        Ok(WasiState {
            fs: self.fs.fork(),
            runtime_state_registration: None,
        })
    }
}

#[cfg(test)]
mod tests {
    fn raw_state_tests_are_not_production_boundaries() {
        let first = parent.fork();
        let second = WasiState { runtime_state_registration: None };
    }
}
'''

STATE_ENV = r'''
fn duplicate(&self) -> WasiEnvInit {
    WasiEnvInit {
        state: WasiState {
            runtime_state_registration: None,
        },
    }
}

pub(crate) fn fork_guarded(
    &self,
) -> Result<(Self, WasiThreadHandle, WasiProcessRegistrationGuard), ControlPlaneError> {
    let state = self.state
        .fork_registered(&self.control_plane, |_| {});
    finish_fork(state)
}

fn from_init(init: WasiEnvInit) {
    let state = init.control_plane.register_runtime_state(init.state);
}

// Decoys cannot satisfy or perturb the production inventory:
// state.fork(); WasiState { runtime_state_registration: None }
const DECOY: &str = "state.fork_registered(); WasiState { }";

#[cfg(test)]
mod tests {
    fn ignored() { parent.fork(); }
}
'''

STATE_BUILDER = r'''
fn build_init() -> WasiEnvInit {
    let state = WasiState {
        runtime_state_registration: None,
    };
    WasiEnvInit { state }
}
'''

CONTROL_PLANE = r'''
impl WasiControlPlane {
    pub(crate) fn register_runtime_state(&self, state: WasiState) -> Arc<WasiState> {
        if !crate::perf::wait_dump_enabled() {
            return Arc::new(state);
        }
        self.register_runtime_state_inner(state)
    }

    fn register_runtime_state_inner(&self, state: WasiState) -> Arc<WasiState> {
        Arc::new_cyclic(|identity| {
            let mut state = state;
            state.runtime_state_registration = Some(WasiRuntimeStateRegistration {
                identity: identity.clone(),
            });
            self.state.runtime_states.lock().unwrap().entries
                .insert(id, identity.clone());
            state
        })
    }
}
'''

CMD_WASMER = r'''
fn reset(env: &mut WasiEnv) {
    env.state = env.state.fork_registered(&env.control_plane, |_| {});
}
'''

PROC_SPAWN = r'''
fn spawn(env: &WasiEnv, child_env: &mut WasiEnv) {
    child_env.state = env.state.fork_registered(&child_env.control_plane, |_| {});
}
'''


class RuntimeStateOwnershipVerifierTests(unittest.TestCase):
    def write_fixture(self, root: Path) -> Path:
        wasmer = root / "wasmer"
        files = {
            "state/mod.rs": STATE_MOD,
            "state/env.rs": STATE_ENV,
            "state/builder.rs": STATE_BUILDER,
            "os/task/control_plane.rs": CONTROL_PLANE,
            "os/command/builtins/cmd_wasmer.rs": CMD_WASMER,
            "syscalls/wasix/proc_spawn.rs": PROC_SPAWN,
        }
        for relative, payload in files.items():
            path = wasmer / "lib/wasix/src" / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(payload, encoding="utf-8")
        return wasmer

    def run_verifier(self, wasmer: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(SCRIPT), "--wasmer-root", str(wasmer)],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def fixture(self) -> tuple[tempfile.TemporaryDirectory[str], Path]:
        temporary = tempfile.TemporaryDirectory()
        return temporary, self.write_fixture(Path(temporary.name))

    def test_accepts_the_exact_registered_ownership_inventory(self) -> None:
        temporary, wasmer = self.fixture()
        with temporary:
            result = self.run_verifier(wasmer)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("verified WASIX runtime-state ownership boundaries", result.stdout)

    def test_rejects_source_replaced_with_symlink_before_open(self) -> None:
        temporary, wasmer = self.fixture()
        with temporary:
            target = wasmer / "lib/wasix/src/state/mod.rs"
            replacement = target.with_name("mod.original.rs")
            real_open = VERIFIER.os.open
            replaced = False

            def replace_then_open(path, flags, mode=0o777, *, dir_fd=None):
                nonlocal replaced
                if Path(path) == target and not replaced:
                    target.rename(replacement)
                    target.symlink_to(replacement)
                    replaced = True
                return real_open(path, flags, mode, dir_fd=dir_fd)

            with mock.patch.object(VERIFIER.os, "open", side_effect=replace_then_open):
                with self.assertRaises(VERIFIER.VerificationError) as raised:
                    VERIFIER.verify(wasmer)
            self.assertTrue(replaced)
            self.assertIn("runtime ownership source", str(raised.exception))

    def test_rejects_same_inode_source_mutation_during_read(self) -> None:
        temporary, wasmer = self.fixture()
        with temporary:
            target = wasmer / "lib/wasix/src/state/mod.rs"
            identity = target.stat()
            real_read = VERIFIER.os.read
            mutated = False

            def mutate_after_read(descriptor, size):
                nonlocal mutated
                payload = real_read(descriptor, size)
                opened = os.fstat(descriptor)
                if (
                    payload
                    and not mutated
                    and (opened.st_dev, opened.st_ino) == (identity.st_dev, identity.st_ino)
                ):
                    source = target.read_bytes()
                    replacement = (b"x" if source[:1] != b"x" else b"y") + source[1:]
                    target.write_bytes(replacement)
                    os.utime(
                        target,
                        ns=(identity.st_atime_ns, identity.st_mtime_ns + 1_000_000_000),
                    )
                    mutated = True
                return payload

            with mock.patch.object(VERIFIER.os, "read", side_effect=mutate_after_read):
                with self.assertRaisesRegex(
                    VERIFIER.VerificationError, "changed while it was read"
                ):
                    VERIFIER.verify(wasmer)
            self.assertTrue(mutated)
            self.assertEqual(target.stat().st_ino, identity.st_ino)
            self.assertEqual(target.stat().st_size, identity.st_size)

    def test_rejects_public_raw_fork(self) -> None:
        temporary, wasmer = self.fixture()
        with temporary:
            path = wasmer / "lib/wasix/src/state/mod.rs"
            source = path.read_text(encoding="utf-8")
            path.write_text(source.replace("    fn fork(&self)", "    pub fn fork(&self)"), encoding="utf-8")
            result = self.run_verifier(wasmer)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("raw WasiState fork must remain private", result.stderr)

    def test_rejects_a_new_raw_fork_escape(self) -> None:
        temporary, wasmer = self.fixture()
        with temporary:
            escape = wasmer / "lib/wasix/src/escape.rs"
            escape.write_text(
                "fn escape(parent: &WasiState) { let leaked = Arc::new(parent.fork()); }\n",
                encoding="utf-8",
            )
            result = self.run_verifier(wasmer)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("raw production fork inventory changed", result.stderr)

    def test_rejects_production_escape_after_a_test_module(self) -> None:
        temporary, wasmer = self.fixture()
        with temporary:
            path = wasmer / "lib/wasix/src/state/env.rs"
            with path.open("a", encoding="utf-8") as handle:
                handle.write("\nfn late_escape(parent: &WasiState) { parent.fork(); }\n")
            result = self.run_verifier(wasmer)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("raw production fork inventory changed", result.stderr)

    def test_rejects_a_new_raw_state_literal(self) -> None:
        temporary, wasmer = self.fixture()
        with temporary:
            escape = wasmer / "lib/wasix/src/escape.rs"
            escape.write_text(
                "fn escape() { let leaked = WasiState { runtime_state_registration: None }; }\n",
                encoding="utf-8",
            )
            result = self.run_verifier(wasmer)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("WasiState literal inventory changed", result.stderr)

    def test_rejects_raw_unfreeze_contract(self) -> None:
        temporary, wasmer = self.fixture()
        with temporary:
            path = wasmer / "lib/wasix/src/state/mod.rs"
            source = path.read_text(encoding="utf-8")
            source = source.replace(
                "bytes: &[u8],\n        control_plane: &WasiControlPlane,\n    ) -> Option<Arc<Self>>",
                "bytes: &[u8],\n    ) -> Option<Self>",
            )
            path.write_text(source, encoding="utf-8")
            result = self.run_verifier(wasmer)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("registered WasiState unfreeze", result.stderr)

    def test_rejects_replacing_registered_fork_with_raw_fork(self) -> None:
        temporary, wasmer = self.fixture()
        with temporary:
            path = wasmer / "lib/wasix/src/os/command/builtins/cmd_wasmer.rs"
            source = path.read_text(encoding="utf-8")
            path.write_text(
                source.replace("fork_registered(&env.control_plane, |_| {})", "fork()"),
                encoding="utf-8",
            )
            result = self.run_verifier(wasmer)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("registered WasiState fork call-site inventory changed", result.stderr)

    def test_rejects_registration_before_fork_preparation(self) -> None:
        temporary, wasmer = self.fixture()
        with temporary:
            path = wasmer / "lib/wasix/src/state/mod.rs"
            source = path.read_text(encoding="utf-8")
            source = source.replace(
                "prepare(&mut state);\n        Ok(control_plane.register_runtime_state(state))",
                "let state = control_plane.register_runtime_state(state);\n"
                "        prepare(Arc::get_mut(&mut state).unwrap());\n"
                "        Ok(state)",
            )
            path.write_text(source, encoding="utf-8")
            result = self.run_verifier(wasmer)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("registered WasiState fork is missing ordered boundary", result.stderr)

    def test_rejects_indirect_guarded_fork_registration(self) -> None:
        temporary, wasmer = self.fixture()
        with temporary:
            path = wasmer / "lib/wasix/src/state/env.rs"
            source = path.read_text(encoding="utf-8")
            source = source.replace(
                "let state = self.state\n        .fork_registered(&self.control_plane, |_| {});",
                "let state = self.duplicate_state();",
            )
            path.write_text(source, encoding="utf-8")
            result = self.run_verifier(wasmer)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("must directly cross the registered state boundary", result.stderr)

    def test_rejects_a_second_registered_fork_boundary(self) -> None:
        temporary, wasmer = self.fixture()
        with temporary:
            path = wasmer / "lib/wasix/src/state/mod.rs"
            with path.open("a", encoding="utf-8") as handle:
                handle.write("\nfn fork_registered(&self) { unreachable!() }\n")
            result = self.run_verifier(wasmer)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("exactly one registered fork boundary", result.stderr)

    def test_rejects_bypassing_initial_registration(self) -> None:
        temporary, wasmer = self.fixture()
        with temporary:
            path = wasmer / "lib/wasix/src/state/env.rs"
            source = path.read_text(encoding="utf-8")
            path.write_text(
                source.replace(
                    "init.control_plane.register_runtime_state(init.state)",
                    "Arc::new(init.state)",
                ),
                encoding="utf-8",
            )
            result = self.run_verifier(wasmer)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("runtime-state registration call-site inventory changed", result.stderr)


if __name__ == "__main__":
    unittest.main()

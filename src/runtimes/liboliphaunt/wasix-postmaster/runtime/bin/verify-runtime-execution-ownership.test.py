#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).with_name("verify-runtime-execution-ownership.py")


def load_verifier():
    spec = importlib.util.spec_from_file_location("runtime_execution_ownership_verifier", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load verifier: {SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


VERIFIER = load_verifier()

ENV = r'''
pub struct WasiEnv {
    deferred_parent_execution: Option<WasiProcessExecutionGuard>,
    current_task_wasm_owner: Weak<()>,
}
impl Clone for WasiEnv {
    fn clone(&self) -> Self {
        Self {
            deferred_parent_execution: None,
            current_task_wasm_owner: Weak::new(),
        }
    }
}
impl WasiEnv {
    pub(crate) fn bind_pending_task_wasm_execution(&mut self, thread: &WasiThread, owner_identity: &Arc<()>) {
        assert!(thread.same_identity(&self.thread));
        let owner = Arc::downgrade(owner_identity);
        assert!(self.current_task_wasm_owner.upgrade().is_none() || Weak::ptr_eq(&self.current_task_wasm_owner, &owner));
        self.current_task_wasm_owner = owner;
    }
    pub(crate) fn accept_task_wasm_execution(&mut self, accepted: &TaskWasmAcceptedExecutionGuard) {
        assert!(accepted.thread().same_identity(&self.thread));
        let accepted_owner = Arc::downgrade(accepted.owner_identity());
        assert!(Weak::ptr_eq(&self.current_task_wasm_owner, &accepted_owner) && self.current_task_wasm_owner.upgrade().is_some());
        let Some(guard) = self.deferred_parent_execution.take() else { return; };
        assert!(guard.try_handoff_to_accepted_task_wasm(&self.process, accepted.thread()));
    }
    pub(crate) fn restore_parent_execution_guard(&mut self, guard: WasiProcessExecutionGuard) {
        assert!(guard.matches_process_thread(&self.process, &self.thread));
        if guard.try_handoff_to_current_task_wasm(&self.process, &self.thread, &self.current_task_wasm_owner) { return; }
        assert!(self.deferred_parent_execution.is_none());
        self.deferred_parent_execution = Some(guard);
    }
    pub(crate) fn acquire_parent_execution_guard(&self) -> Result<WasiProcessExecutionGuard, Error> {
        self.process.acquire_supplemental_execution_guard(
            self.thread.clone(),
            self.current_task_wasm_owner.clone(),
        )
    }
    pub(crate) fn clone_for_thread_spawn(&self, thread: WasiThread, layout: WasiMemoryLayout) -> Self {
        assert!(self.vfork.is_none());
        let mut env = self.clone();
        env.current_task_wasm_owner = Weak::new();
        env.thread = thread;
        env.layout = layout;
        env
    }
    pub(crate) fn take_for_same_thread_continuation(&mut self) -> Self {
        let mut env = self.clone();
        env.deferred_parent_execution = self.deferred_parent_execution.take();
        env
    }
    pub(crate) fn swap_inner(&mut self, other: &mut Self) {
        std::mem::swap(&mut self.inner, &mut other.inner);
        std::mem::swap(&mut self.current_task_wasm_owner, &mut other.current_task_wasm_owner);
    }
}
'''

PROCESS = r'''
struct WasiProcessExecutionHandoffOwner {
    thread: WasiThread,
    task_wasm_owner: Weak<()>,
}
impl Drop for WasiProcessExecutionGuardInner {
    fn drop(&mut self) {
        let lease = self.lease.get_mut().unwrap().take();
        if lease.is_none() { return; }
        if self.fail_closed.load(Ordering::Acquire) {
            if let Some(owner) = &self.handoff_owner {
                owner.thread.set_status_finished(Ok(Errno::Canceled.into()));
            }
            self.process.terminate(Errno::Canceled.into());
            self.process.finished.set_finished(Ok(Errno::Canceled.into()));
        }
        drop(lease);
    }
}
impl WasiProcessExecutionGuard {
    fn release_handoff_lease(&self) -> bool {
        let mut lease = self.inner.lease.lock().unwrap();
        let Some(current) = lease.take() else { return false; };
        drop(lease);
        drop(current);
        true
    }
    pub(crate) fn try_handoff_to_current_task_wasm(&self, process: &WasiProcess, thread: &WasiThread, current_owner: &Weak<()>) -> bool {
        let Some(expected) = self.inner.handoff_owner.as_ref() else { return false; };
        if !self.matches_process_thread(process, thread)
            || !Weak::ptr_eq(&expected.task_wasm_owner, current_owner)
            || current_owner.upgrade().is_none() { return false; }
        self.release_handoff_lease()
    }
    pub(crate) fn try_handoff_to_accepted_task_wasm(&self, process: &WasiProcess, thread: &WasiThread) -> bool {
        self.matches_process_thread(process, thread) && self.release_handoff_lease()
    }
}
impl WasiProcess {
    pub(crate) fn acquire_supplemental_execution_guard(&self, thread: WasiThread, task_wasm_owner: Weak<()>) -> Result<WasiProcessExecutionGuard, Error> {
        let owns_thread = self.threads.values().any(|candidate| candidate.same_identity(&thread));
        if !owns_thread || task_wasm_owner.upgrade().is_none() { return Err(Error); }
        let lease = self.acquire_execution_lease()?;
        Ok(WasiProcessExecutionGuard::new(self.clone(), lease, false, Some(WasiProcessExecutionHandoffOwner {
            thread,
            task_wasm_owner,
        })))
    }
}
'''

TASK_MANAGER = r'''
pub struct TaskWasmExecutionGuard { owner_identity: Arc<()> }
pub struct TaskWasmAcceptedExecutionGuard { owner_identity: Arc<()> }
impl TaskWasmExecutionGuard {
    fn into_accepted_callback(mut self) -> TaskWasmAcceptedExecutionGuard { accepted() }
    fn bind_pending_owner(&self, env: &mut WasiEnv) { env.bind_pending_task_wasm_execution(&self.thread, &self.owner_identity); }
    pub fn accept_callback(self, env: &mut WasiEnv) -> TaskWasmAcceptedExecutionGuard {
        let accepted = self.into_accepted_callback();
        env.accept_task_wasm_execution(&accepted);
        accepted
    }
}
impl TaskWasm {
    pub fn new(mut env: WasiEnv) -> Self {
        let execution_lease = if env.process.guest_start_is_committed() { Ok(guard()) } else { Err(error()) };
        if let Ok(execution) = &execution_lease {
            execution.bind_pending_owner(&mut env);
        }
        Self { env, execution_lease }
    }
}
fn resume(env: &mut WasiEnv) { let next = env.take_for_same_thread_continuation(); }
'''

TOKIO = r'''
fn trigger(guard: Guard, env: &mut WasiEnv) { let accepted = guard.accept_callback(env); }
fn blocking(guard: Guard, env: &mut WasiEnv) { let accepted = guard.accept_callback(env); }
'''

THREAD_SPAWN = r'''
fn thread_spawn_internal_from_wasi(ctx: &mut Context) -> Result<Tid, Errno> {
    let env = ctx.data();
    if env.vfork.is_some() {
        return Err(Errno::Notsup);
    }
    let thread = env.process.new_thread(layout, start)?;
    Ok(thread.id())
}
fn spawn(env: &WasiEnv) { let thread_env = env.clone_for_thread_spawn(thread, layout); }
'''

PROC_FORK = r'''
pub fn proc_fork<M: MemorySize>(
    mut ctx: FunctionEnvMut<'_, WasiEnv>,
    copy_memory: Bool,
    pid_ptr: WasmPtr<Pid, M>,
) -> Result<Errno, WasiError> {
    WasiEnv::do_pending_operations(&mut ctx)?;
    if let Some(context_switching_environment) = ctx.data().context_switching_environment.as_ref() {
        return Ok(Errno::Notsup);
    }
    if let Some(result) = unsafe { handle_rewind::<M, ForkResult>(&mut ctx) } {
        let memory = unsafe { ctx.data().memory_view(&ctx) };
        pid_ptr.write(&memory, result.pid)?;
        return Ok(result.ret);
    }
    if copy_memory == Bool::True {
        return Ok(Errno::Notsup);
    }
    if let Some(vfork) = ctx.data().vfork.as_ref() {
        return Ok(Errno::Notsup);
    }
    let supports_asyncify = ctx.data().inner().supports_asyncify_stack_rewind();
    if !supports_asyncify {
        return Ok(Errno::Notsup);
    }
    let memory = unsafe { ctx.data().memory_view(&ctx) };
    pid_ptr.write(&memory, 0)?;
    let (mut child_env, child_handle, mut child_registration) = ctx.data().fork_guarded()?;
    unwind::<M, _>(ctx, move |mut ctx, memory_stack, rewind_stack| {
        child_registration.commit_child()?;
        let parent_execution = ctx.data().acquire_parent_execution_guard()?;
        child_env.swap_inner(ctx.data_mut());
        let action = rewind::<M, _>(ctx.as_mut(), memory_stack, rewind_stack);
        ctx.data_mut().restore_parent_execution_guard(parent_execution);
        action
    })
}
'''
PROC_FORK_ENV = r'''
fn fork_env(ctx: &mut Context) { let guard = ctx.data().acquire_parent_execution_guard(); }
'''
PROC_EXEC3 = r'''
fn exec(ctx: &mut Context) {
    let env = ctx.data_mut().take_for_same_thread_continuation();
    ctx.data_mut().restore_parent_execution_guard(guard);
}
'''
PROC_EXIT2 = r'''
fn exit(ctx: &mut Context) { ctx.data_mut().restore_parent_execution_guard(guard); }
'''
BIN_EXEC = r'''
fn resume(ctx: &mut Context) { ctx.data_mut().restore_parent_execution_guard(guard); }
'''


class RuntimeExecutionOwnershipVerifierTests(unittest.TestCase):
    def write_fixture(self, root: Path) -> Path:
        wasmer = root / "wasmer"
        files = {
            "state/env.rs": ENV,
            "os/task/process.rs": PROCESS,
            "runtime/task_manager/mod.rs": TASK_MANAGER,
            "runtime/task_manager/tokio.rs": TOKIO,
            "syscalls/wasix/thread_spawn.rs": THREAD_SPAWN,
            "syscalls/wasix/proc_fork.rs": PROC_FORK,
            "syscalls/wasix/proc_fork_env.rs": PROC_FORK_ENV,
            "syscalls/wasix/proc_exec3.rs": PROC_EXEC3,
            "syscalls/wasix/proc_exit2.rs": PROC_EXIT2,
            "bin_factory/exec.rs": BIN_EXEC,
        }
        for relative, payload in files.items():
            path = wasmer / "lib/wasix/src" / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(payload, encoding="utf-8")
        return wasmer

    def run_verifier(self, wasmer: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--wasmer-root", str(wasmer)],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def fixture(self) -> tuple[tempfile.TemporaryDirectory[str], Path]:
        temporary = tempfile.TemporaryDirectory()
        return temporary, self.write_fixture(Path(temporary.name))

    def assert_rejected(self, relative: str, old: str, new: str, message: str) -> None:
        temporary, wasmer = self.fixture()
        with temporary:
            path = wasmer / "lib/wasix/src" / relative
            source = path.read_text(encoding="utf-8")
            self.assertIn(old, source)
            path.write_text(source.replace(old, new, 1), encoding="utf-8")
            result = self.run_verifier(wasmer)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(message, result.stderr)

    def test_accepts_exact_bounded_execution_ownership(self) -> None:
        temporary, wasmer = self.fixture()
        with temporary:
            result = self.run_verifier(wasmer)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("verified exact bounded", result.stdout)

    def test_rejects_source_replaced_with_symlink_before_open(self) -> None:
        temporary, wasmer = self.fixture()
        with temporary:
            target = wasmer / "lib/wasix/src/state/env.rs"
            replacement = target.with_name("env.original.rs")
            real_open = VERIFIER.RUST.os.open
            replaced = False

            def replace_then_open(path, flags, mode=0o777, *, dir_fd=None):
                nonlocal replaced
                if Path(path) == target and not replaced:
                    target.rename(replacement)
                    target.symlink_to(replacement)
                    replaced = True
                return real_open(path, flags, mode, dir_fd=dir_fd)

            with mock.patch.object(VERIFIER.RUST.os, "open", side_effect=replace_then_open):
                with self.assertRaises(VERIFIER.VerificationError) as raised:
                    VERIFIER.verify(wasmer)
            self.assertTrue(replaced)
            self.assertIn("runtime ownership source", str(raised.exception))

    def test_rejects_same_inode_source_mutation_during_read(self) -> None:
        temporary, wasmer = self.fixture()
        with temporary:
            target = wasmer / "lib/wasix/src/state/env.rs"
            identity = target.stat()
            real_read = VERIFIER.RUST.os.read
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

            with mock.patch.object(VERIFIER.RUST.os, "read", side_effect=mutate_after_read):
                with self.assertRaisesRegex(
                    VERIFIER.VerificationError, "changed while it was read"
                ):
                    VERIFIER.verify(wasmer)
            self.assertTrue(mutated)
            self.assertEqual(target.stat().st_ino, identity.st_ino)
            self.assertEqual(target.stat().st_size, identity.st_size)

    def test_rejects_unbounded_guard_vector(self) -> None:
        self.assert_rejected(
            "state/env.rs",
            "deferred_parent_execution: Option<WasiProcessExecutionGuard>",
            "execution_guards: Vec<WasiProcessExecutionGuard>",
            "unbounded execution_guards storage",
        )

    def test_rejects_generic_clone_aliasing_deferred_owner(self) -> None:
        self.assert_rejected(
            "state/env.rs",
            "deferred_parent_execution: None,",
            "deferred_parent_execution: self.deferred_parent_execution.clone(),",
            "non-owning WasiEnv clone",
        )

    def test_rejects_non_linearizable_consumed_handoff(self) -> None:
        self.assert_rejected(
            "os/task/process.rs",
            "let Some(current) = lease.take() else { return false; };",
            "let Some(current) = lease.take() else { return true; };",
            "one-shot handoff release",
        )

    def test_rejects_process_count_handoff_inference(self) -> None:
        self.assert_rejected(
            "os/task/process.rs",
            "|| !Weak::ptr_eq(&expected.task_wasm_owner, current_owner)",
            "|| self.process.lock().execution_leases < 2",
            "current physical owner handoff",
        )

    def test_rejects_constructor_without_pending_owner_bind(self) -> None:
        self.assert_rejected(
            "runtime/task_manager/mod.rs",
            "execution.bind_pending_owner(&mut env);",
            "let _ = execution;",
            "TaskWasm constructor owner binding",
        )

    def test_rejects_thread_spawn_without_pre_registration_vfork_check(self) -> None:
        self.assert_rejected(
            "syscalls/wasix/thread_spawn.rs",
            "if env.vfork.is_some()",
            "if false",
            "vfork thread-spawn rejection",
        )

    def test_rejects_copy_memory_rejection_after_child_construction(self) -> None:
        rejection = '''    if copy_memory == Bool::True {
        return Ok(Errno::Notsup);
    }
'''
        child_construction = (
            "    let (mut child_env, child_handle, mut child_registration) = "
            "ctx.data().fork_guarded()?;\n"
        )
        temporary, wasmer = self.fixture()
        with temporary:
            path = wasmer / "lib/wasix/src/syscalls/wasix/proc_fork.rs"
            source = path.read_text(encoding="utf-8")
            self.assertEqual(source.count(rejection), 1)
            self.assertEqual(source.count(child_construction), 1)
            source = source.replace(rejection, "", 1)
            source = source.replace(
                child_construction, child_construction + rejection, 1
            )
            path.write_text(source, encoding="utf-8")
            result = self.run_verifier(wasmer)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("proc_fork vfork-only construction ordering", result.stderr)

    def test_rejects_reintroduced_copy_memory_spawn(self) -> None:
        self.assert_rejected(
            "syscalls/wasix/proc_fork.rs",
            "        child_registration.commit_child()?;",
            "        let spawn = SpawnType::CopyMemory(memory, ctx.as_store_ref());\n"
            "        child_registration.commit_child()?;",
            "proc_fork must not contain SpawnType::CopyMemory",
        )

    def test_rejects_continuation_guard_alias_instead_of_transfer(self) -> None:
        self.assert_rejected(
            "state/env.rs",
            "env.deferred_parent_execution = self.deferred_parent_execution.take();",
            "env.deferred_parent_execution = self.deferred_parent_execution.clone();",
            "same-thread ownership transfer",
        )

    def test_rejects_unexpected_restore_call_site(self) -> None:
        temporary, wasmer = self.fixture()
        with temporary:
            escape = wasmer / "lib/wasix/src/escape.rs"
            escape.write_text(
                "fn escape(env: &mut WasiEnv) { env.restore_parent_execution_guard(guard); }\n",
                encoding="utf-8",
            )
            result = self.run_verifier(wasmer)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("parent owner restore inventory changed", result.stderr)


if __name__ == "__main__":
    unittest.main()

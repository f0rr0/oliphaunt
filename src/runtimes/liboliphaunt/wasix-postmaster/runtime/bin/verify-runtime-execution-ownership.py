#!/usr/bin/env python3

from __future__ import annotations

import argparse
from collections import Counter
import importlib.util
from pathlib import Path
import re
import sys


SOURCE_ROOT = Path("lib/wasix/src")
REQUIRED_FILES = (
    Path("state/env.rs"),
    Path("os/task/process.rs"),
    Path("runtime/task_manager/mod.rs"),
    Path("runtime/task_manager/tokio.rs"),
    Path("syscalls/wasix/thread_spawn.rs"),
    Path("syscalls/wasix/proc_fork.rs"),
    Path("syscalls/wasix/proc_fork_env.rs"),
    Path("syscalls/wasix/proc_exec3.rs"),
    Path("syscalls/wasix/proc_exit2.rs"),
    Path("bin_factory/exec.rs"),
)
EXPECTED_PARENT_ACQUIRE_CALLS = Counter(
    {
        Path("syscalls/wasix/proc_fork.rs"): 1,
        Path("syscalls/wasix/proc_fork_env.rs"): 1,
    }
)
EXPECTED_PARENT_RESTORE_CALLS = Counter(
    {
        Path("syscalls/wasix/proc_fork.rs"): 1,
        Path("syscalls/wasix/proc_exec3.rs"): 1,
        Path("syscalls/wasix/proc_exit2.rs"): 1,
        Path("bin_factory/exec.rs"): 1,
    }
)
EXPECTED_CONTINUATION_TRANSFERS = Counter(
    {
        Path("runtime/task_manager/mod.rs"): 1,
        Path("syscalls/wasix/proc_exec3.rs"): 1,
    }
)


def load_rust_parser():
    parser_path = Path(__file__).with_name("verify-runtime-state-ownership.py")
    spec = importlib.util.spec_from_file_location("oliphaunt_runtime_state_verifier", parser_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load Rust ownership parser: {parser_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


RUST = load_rust_parser()
VerificationError = RUST.VerificationError


def extract_block(code: str, signature: re.Pattern[str], description: str) -> str:
    matches = list(signature.finditer(code))
    if len(matches) != 1:
        raise VerificationError(f"expected exactly one {description}; found {len(matches)}")
    opening = code.find("{", matches[0].start(), matches[0].end())
    depth = 0
    for index in range(opening, len(code)):
        if code[index] == "{":
            depth += 1
        elif code[index] == "}":
            depth -= 1
            if depth == 0:
                return code[opening + 1 : index]
    raise VerificationError(f"unterminated {description}")


def extract_drop_impl(code: str, type_name: str) -> str:
    return extract_block(
        code,
        re.compile(rf"\bimpl\s+Drop\s+for\s+{re.escape(type_name)}\s*\{{"),
        f"Drop implementation for {type_name}",
    )


def extract_type_impl(code: str, type_name: str) -> str:
    return extract_block(
        code,
        re.compile(
            rf"\bimpl(?:\s*<[^{{}}]+>)?\s+{re.escape(type_name)}(?:\s*<[^{{}}]+>)?\s*\{{"
        ),
        f"inherent implementation for {type_name}",
    )


def function(code: str, name: str, description: str) -> str:
    return RUST.extract_function(
        code,
        re.compile(
            rf"(?ms)^\s*(?:pub(?:\s*\(\s*crate\s*\))?\s+)?(?:unsafe\s+)?fn\s+{re.escape(name)}(?:\s*<[^{{}}]+>)?\s*\([^{{}}]*?\)\s*(?:->\s*[^{{}}]+)?\s*\{{"
        ),
        description,
    )


def require(body: str, fragments: tuple[str, ...], description: str) -> None:
    RUST.require_ordered(body, fragments, description)


def exact_field(code: str, pattern: str, description: str) -> None:
    count = len(re.findall(pattern, code))
    if count != 1:
        raise VerificationError(f"{description} must occur exactly once; found {count}")


def verify(wasmer_root: Path) -> None:
    source_root = wasmer_root / SOURCE_ROOT
    if not source_root.is_dir() or source_root.is_symlink():
        raise VerificationError(f"missing non-symlink Wasmer WASIX source root: {source_root}")

    for relative in REQUIRED_FILES:
        RUST.read_regular(source_root / relative)

    sources: dict[Path, str] = {}
    for path in sorted(source_root.rglob("*.rs")):
        sources[path.relative_to(source_root)] = RUST.production_code(RUST.read_regular(path))
    combined = "\n".join(sources.values())
    if re.search(r"\bexecution_guards\b", combined):
        raise VerificationError("unbounded execution_guards storage is forbidden")
    if re.search(r"Vec\s*<\s*WasiProcessExecutionGuard\s*>", combined):
        raise VerificationError("vfork execution ownership must not use Vec cardinality")

    env = sources[Path("state/env.rs")]
    exact_field(
        env,
        r"deferred_parent_execution\s*:\s*Option\s*<\s*WasiProcessExecutionGuard\s*>",
        "bounded deferred parent owner field",
    )
    exact_field(
        env,
        r"current_task_wasm_owner\s*:\s*Weak\s*<\s*\(\s*\)\s*>",
        "physical TaskWasm owner field",
    )
    clone = function(env, "clone", "WasiEnv generic clone")
    require(
        clone,
        (
            "deferred_parent_execution: None,",
            "current_task_wasm_owner: Weak::new(),",
        ),
        "non-owning WasiEnv clone",
    )
    if "self.deferred_parent_execution.clone()" in clone:
        raise VerificationError("generic WasiEnv clone must not alias deferred ownership")

    bind = function(env, "bind_pending_task_wasm_execution", "pending owner bind")
    require(
        bind,
        (
            "thread.same_identity(&self.thread)",
            "let owner = Arc::downgrade(owner_identity);",
            "self.current_task_wasm_owner.upgrade().is_none()",
            "Weak::ptr_eq(&self.current_task_wasm_owner, &owner)",
            "self.current_task_wasm_owner = owner;",
        ),
        "pending owner bind",
    )
    accept = function(env, "accept_task_wasm_execution", "accepted owner bind")
    require(
        accept,
        (
            "accepted.thread().same_identity(&self.thread)",
            "let accepted_owner = Arc::downgrade(accepted.owner_identity());",
            "Weak::ptr_eq(&self.current_task_wasm_owner, &accepted_owner)",
            "self.current_task_wasm_owner.upgrade().is_some()",
            "self.deferred_parent_execution.take()",
            "guard.try_handoff_to_accepted_task_wasm(&self.process, accepted.thread())",
        ),
        "accepted owner bind",
    )
    restore = function(env, "restore_parent_execution_guard", "parent owner restore")
    require(
        restore,
        (
            "guard.matches_process_thread(&self.process, &self.thread)",
            "guard.try_handoff_to_current_task_wasm(",
            "self.deferred_parent_execution.is_none()",
            "self.deferred_parent_execution = Some(guard);",
        ),
        "parent owner restore",
    )
    if "execution_leases" in restore:
        raise VerificationError("parent restore must not infer ownership from process lease counts")
    acquire = function(env, "acquire_parent_execution_guard", "parent owner acquisition")
    require(
        acquire,
        (
            "self.process.acquire_supplemental_execution_guard(",
            "self.thread.clone(),",
            "self.current_task_wasm_owner.clone(),",
        ),
        "parent owner acquisition",
    )
    retarget = function(env, "clone_for_thread_spawn", "thread-retarget clone")
    require(
        retarget,
        (
            "self.vfork.is_none()",
            "let mut env = self.clone();",
            "env.current_task_wasm_owner = Weak::new();",
            "env.thread = thread;",
        ),
        "thread-retarget clone",
    )
    continuation = function(
        env, "take_for_same_thread_continuation", "same-thread ownership transfer"
    )
    require(
        continuation,
        (
            "let mut env = self.clone();",
            "env.deferred_parent_execution = self.deferred_parent_execution.take();",
        ),
        "same-thread ownership transfer",
    )
    swap = function(env, "swap_inner", "physical instance swap")
    require(
        swap,
        (
            "std::mem::swap(&mut self.inner, &mut other.inner);",
            "&mut self.current_task_wasm_owner,",
            "&mut other.current_task_wasm_owner",
        ),
        "physical instance swap",
    )

    process = sources[Path("os/task/process.rs")]
    exact_field(
        process,
        r"struct\s+WasiProcessExecutionHandoffOwner\s*\{[^}]*thread\s*:\s*WasiThread\s*,[^}]*task_wasm_owner\s*:\s*Weak\s*<\s*\(\s*\)\s*>",
        "exact supplemental handoff owner",
    )
    release = function(process, "release_handoff_lease", "one-shot handoff release")
    require(
        release,
        (
            "let mut lease = self.inner.lease.lock().unwrap();",
            "let Some(current) = lease.take() else",
            "return false;",
            "drop(current);",
            "true",
        ),
        "one-shot handoff release",
    )
    current = function(
        process, "try_handoff_to_current_task_wasm", "current physical owner handoff"
    )
    require(
        current,
        (
            "self.matches_process_thread(process, thread)",
            "Weak::ptr_eq(&expected.task_wasm_owner, current_owner)",
            "current_owner.upgrade().is_none()",
            "self.release_handoff_lease()",
        ),
        "current physical owner handoff",
    )
    accepted = function(
        process, "try_handoff_to_accepted_task_wasm", "accepted successor handoff"
    )
    require(
        accepted,
        (
            "self.matches_process_thread(process, thread)",
            "self.release_handoff_lease()",
        ),
        "accepted successor handoff",
    )
    if "execution_leases" in current or "execution_leases" in accepted:
        raise VerificationError("TaskWasm handoff must not use process-wide lease counts")
    supplemental = function(
        process, "acquire_supplemental_execution_guard", "supplemental owner acquisition"
    )
    require(
        supplemental,
        (
            "any(|candidate| candidate.same_identity(&thread))",
            "task_wasm_owner.upgrade().is_none()",
            "let lease = self.acquire_execution_lease()?;",
            "Some(WasiProcessExecutionHandoffOwner",
            "thread,",
            "task_wasm_owner,",
        ),
        "supplemental owner acquisition",
    )
    guard_drop = function(
        extract_drop_impl(process, "WasiProcessExecutionGuardInner"),
        "drop",
        "supplemental guard destructor",
    )
    require(
        guard_drop,
        (
            "owner.thread.set_status_finished(Ok(Errno::Canceled.into()));",
            "self.process.terminate(Errno::Canceled.into());",
            "self.process",
            ".finished",
            ".set_finished(Ok(Errno::Canceled.into()));",
            "drop(lease);",
        ),
        "supplemental guard fail-closed destructor",
    )

    task_manager = sources[Path("runtime/task_manager/mod.rs")]
    if len(re.findall(r"owner_identity\s*:\s*Arc\s*<\s*\(\s*\)\s*>", task_manager)) != 2:
        raise VerificationError("pending and accepted TaskWasm guards must each carry owner identity")
    if re.search(r"pub(?:\s*\([^)]*\))?\s+fn\s+into_accepted_callback", task_manager):
        raise VerificationError("raw pending-to-accepted conversion must remain private")
    accept_callback = function(task_manager, "accept_callback", "public callback acceptance")
    require(
        accept_callback,
        (
            "let accepted = self.into_accepted_callback();",
            "env.accept_task_wasm_execution(&accepted);",
            "accepted",
        ),
        "public callback acceptance",
    )
    constructor = function(
        extract_type_impl(task_manager, "TaskWasm"), "new", "TaskWasm constructor"
    )
    require(
        constructor,
        (
            "let execution_lease = if env.process.guest_start_is_committed()",
            "if let Ok(execution) = &execution_lease",
            "execution.bind_pending_owner(&mut env);",
            "Self",
        ),
        "TaskWasm constructor owner binding",
    )

    tokio = sources[Path("runtime/task_manager/tokio.rs")]
    if len(re.findall(r"\.accept_callback\s*\(", tokio)) != 2:
        raise VerificationError("Tokio task manager must accept both trigger and blocking callbacks")
    if "into_accepted_callback" in tokio or "accept_task_wasm_execution" in tokio:
        raise VerificationError("Tokio must use the public atomic callback acceptance boundary")

    thread_spawn = sources[Path("syscalls/wasix/thread_spawn.rs")]
    spawn_from_wasi = function(
        thread_spawn, "thread_spawn_internal_from_wasi", "guest thread spawn"
    )
    require(
        spawn_from_wasi,
        (
            "if env.vfork.is_some()",
            "return Err(Errno::Notsup);",
            "env.process.new_thread(",
        ),
        "vfork thread-spawn rejection",
    )
    if len(re.findall(r"\.clone_for_thread_spawn\s*\(", thread_spawn)) != 1:
        raise VerificationError("thread spawn must use the explicit non-owning retarget clone")
    if re.search(r"thread_env\s*\.\s*thread\s*=", thread_spawn):
        raise VerificationError("thread spawn must not manually retarget a generic WasiEnv clone")

    proc_fork_source = sources[Path("syscalls/wasix/proc_fork.rs")]
    proc_fork = function(proc_fork_source, "proc_fork", "proc_fork syscall")
    require(
        proc_fork,
        (
            "handle_rewind::<M, ForkResult>(&mut ctx)",
            "return Ok(result.ret);",
            "if copy_memory == Bool::True",
        ),
        "proc_fork restored-continuation ordering",
    )
    copy_memory_rejection = extract_block(
        proc_fork,
        re.compile(r"\bif\s+copy_memory\s*==\s*Bool\s*::\s*True\s*\{"),
        "copy_memory rejection",
    )
    require(
        copy_memory_rejection,
        ("return Ok(Errno::Notsup);",),
        "copy_memory fail-closed rejection",
    )
    require(
        proc_fork,
        (
            "if copy_memory == Bool::True",
            "return Ok(Errno::Notsup);",
            "ctx.data().fork_guarded()",
            "unwind::<M, _>(ctx, move",
        ),
        "proc_fork vfork-only construction ordering",
    )
    unwind_paths = len(
        re.findall(r"\bunwind\s*::\s*<\s*M\s*,\s*_\s*>\s*\(", proc_fork)
    )
    if unwind_paths != 1:
        raise VerificationError(
            f"proc_fork must contain exactly one vfork unwind path; found {unwind_paths}"
        )
    forbidden_proc_fork_surfaces = (
        (r"\bSpawnType\s*::\s*CopyMemory\b", "SpawnType::CopyMemory"),
        (
            r"\bfork_guarded_for_copied_memory\b",
            "fork_guarded_for_copied_memory",
        ),
        (
            r"(?m)^\s*fn\s+(?:run|[A-Za-z0-9_]*copied[A-Za-z0-9_]*child[A-Za-z0-9_]*)\b",
            "copied-child run helper",
        ),
        (r"\bTaskWasm\s*::\s*new\b|\.\s*task_wasm\s*\(", "copied-child task runner"),
    )
    for pattern, description in forbidden_proc_fork_surfaces:
        if re.search(pattern, proc_fork_source):
            raise VerificationError(f"proc_fork must not contain {description}")

    acquire_calls: Counter[Path] = Counter()
    restore_calls: Counter[Path] = Counter()
    continuation_calls: Counter[Path] = Counter()
    supplemental_calls: Counter[Path] = Counter()
    for relative, code in sources.items():
        acquire_calls[relative] = len(re.findall(r"\.acquire_parent_execution_guard\s*\(", code))
        restore_calls[relative] = len(re.findall(r"\.restore_parent_execution_guard\s*\(", code))
        continuation_calls[relative] = len(
            re.findall(r"\.take_for_same_thread_continuation\s*\(", code)
        )
        supplemental_calls[relative] = len(
            re.findall(r"\.acquire_supplemental_execution_guard\s*\(", code)
        )
    acquire_calls += Counter()
    restore_calls += Counter()
    continuation_calls += Counter()
    supplemental_calls += Counter()
    if acquire_calls != EXPECTED_PARENT_ACQUIRE_CALLS:
        raise VerificationError(f"parent owner acquisition inventory changed: {dict(acquire_calls)}")
    if restore_calls != EXPECTED_PARENT_RESTORE_CALLS:
        raise VerificationError(f"parent owner restore inventory changed: {dict(restore_calls)}")
    if continuation_calls != EXPECTED_CONTINUATION_TRANSFERS:
        raise VerificationError(
            f"same-thread ownership transfer inventory changed: {dict(continuation_calls)}"
        )
    if supplemental_calls != Counter({Path("state/env.rs"): 1}):
        raise VerificationError(
            f"supplemental owner acquisition inventory changed: {dict(supplemental_calls)}"
        )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify exact, bounded WASIX TaskWasm/vfork execution ownership"
    )
    parser.add_argument("--wasmer-root", required=True, type=Path)
    args = parser.parse_args()
    try:
        verify(args.wasmer_root)
    except (OSError, UnicodeError, RuntimeError, VerificationError) as error:
        print(f"runtime execution ownership verification failed: {error}", file=sys.stderr)
        return 1
    print("verified exact bounded WASIX runtime execution ownership")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

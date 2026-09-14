use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    env, fs,
    ops::Range,
};

use anyhow::{Context, Result, bail, ensure};
use serde::Serialize;
use sha2::{Digest, Sha256};
use wasmparser::{ExternalKind, Operator, Parser, Payload, TypeRef, Validator, WasmFeatures};

const PROOF_SCHEMA: &str = "oliphaunt.wasix-postmaster.deterministic-start-proof.v1";
const POLICY: &str = "llvm-shared-memory-init-restricted-effects.v1";
const START_EXPORT: &str = "__wasm_init_memory";

#[derive(Debug, Default)]
struct Effects {
    allowed: bool,
    rejection: Option<String>,
    calls: BTreeMap<u32, u32>,
    global_gets: BTreeSet<u32>,
    global_sets: BTreeSet<u32>,
    memory_init: Vec<u32>,
    data_drop: Vec<u32>,
    block_count: u32,
    br_count: u32,
    br_table_count: u32,
    memory_fill_count: u32,
    cmpxchg_count: u32,
    atomic_store_count: u32,
    atomic_notify_count: u32,
    atomic_wait_count: u32,
}

#[derive(Debug)]
struct BodySummary {
    range: Range<usize>,
    effects: Effects,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
struct Proof {
    schema: &'static str,
    analyzer_policy: &'static str,
    module_sha256: String,
    proof_sha256: String,
    start_function_index: u32,
    start_function_export: &'static str,
    transitive_function_indices: Vec<u32>,
    imported_function_calls: u32,
    memory_reads: &'static str,
    memory_effects: &'static str,
    global_effects: &'static str,
    table_effects: &'static str,
    requires_fresh_zeroed_memory: bool,
    ordinary_start_execution_per_instance: bool,
    first_instance_full_byte_validation: bool,
}

fn main() -> Result<()> {
    let mut arguments = env::args().skip(1);
    let path = arguments
        .next()
        .context("usage: oliphaunt-wasix-start-proof MODULE | --policy-id")?;
    if path == "--policy-id" {
        ensure!(
            arguments.next().is_none(),
            "--policy-id accepts no arguments"
        );
        println!("{POLICY}");
        return Ok(());
    }
    ensure!(
        arguments.next().is_none(),
        "analyzer accepts exactly one module"
    );
    let bytes = fs::read(&path).with_context(|| format!("read {path}"))?;
    Validator::new_with_features(WasmFeatures::default() | WasmFeatures::THREADS)
        .validate_all(&bytes)
        .context("validate input WebAssembly")?;

    let module_sha256 = hex::encode(Sha256::digest(&bytes));
    let mut imported_functions = 0_u32;
    let mut imported_globals = Vec::new();
    let mut shared_memory_imports = 0_u32;
    let mut start = None;
    let mut function_exports = BTreeMap::new();
    let mut bodies = BTreeMap::new();
    let mut local_body = 0_u32;
    let mut passive_data = BTreeMap::new();

    for payload in Parser::new(0).parse_all(&bytes) {
        match payload? {
            Payload::ImportSection(section) => {
                for import in section.into_imports() {
                    let import = import?;
                    match import.ty {
                        TypeRef::Func(_) | TypeRef::FuncExact(_) => imported_functions += 1,
                        TypeRef::Global(ty) => {
                            imported_globals.push((
                                import.module.to_owned(),
                                import.name.to_owned(),
                                ty,
                            ));
                        }
                        TypeRef::Memory(ty)
                            if import.module == "env" && import.name == "memory" && ty.shared =>
                        {
                            shared_memory_imports += 1;
                        }
                        _ => {}
                    }
                }
            }
            Payload::ExportSection(section) => {
                for export in section {
                    let export = export?;
                    if export.kind == ExternalKind::Func {
                        function_exports.insert(export.name.to_owned(), export.index);
                    }
                }
            }
            Payload::StartSection { func, .. } => start = Some(func),
            Payload::CodeSectionEntry(body) => {
                let index = imported_functions + local_body;
                local_body += 1;
                bodies.insert(
                    index,
                    BodySummary {
                        range: body.range(),
                        effects: analyze_body(body)?,
                    },
                );
            }
            Payload::DataSection(section) => {
                for (index, data) in section.into_iter().enumerate() {
                    let data = data?;
                    ensure!(
                        matches!(data.kind, wasmparser::DataKind::Passive),
                        "deterministic-start policy rejects active data segment {index}"
                    );
                    passive_data.insert(index as u32, data.data.len());
                }
            }
            _ => {}
        }
    }

    ensure!(
        shared_memory_imports == 1,
        "policy requires one shared env.memory import"
    );
    let start = start.context("module has no start section")?;
    ensure!(
        function_exports.get(START_EXPORT) == Some(&start),
        "module start is not exported as {START_EXPORT}"
    );
    ensure!(start >= imported_functions, "module start is imported");

    let mut closure = BTreeSet::new();
    let mut queue = VecDeque::from([start]);
    while let Some(index) = queue.pop_front() {
        if !closure.insert(index) {
            continue;
        }
        ensure!(
            index >= imported_functions,
            "start closure calls imported function {index}"
        );
        let body = bodies
            .get(&index)
            .with_context(|| format!("missing body for local function {index}"))?;
        ensure!(
            body.effects.allowed,
            "function {index} is outside restricted-effects policy: {}",
            body.effects
                .rejection
                .as_deref()
                .unwrap_or("unknown operator")
        );
        for called in body.effects.calls.keys() {
            if *called < imported_functions {
                bail!("start closure calls imported function {called}");
            }
            queue.push_back(*called);
        }
    }

    validate_call_shape(start, &closure, &bodies)?;
    let start_effects = &bodies.get(&start).unwrap().effects;
    ensure!(
        start_effects.block_count == 3,
        "unexpected LLVM init guard block shape"
    );
    ensure!(
        start_effects.br_table_count == 1 && start_effects.br_count == 1,
        "unexpected LLVM init guard branches"
    );
    ensure!(
        start_effects.cmpxchg_count == 1,
        "policy requires one initialization-guard cmpxchg"
    );
    ensure!(
        start_effects.atomic_store_count == 1,
        "policy requires one initialization-guard store"
    );
    ensure!(
        start_effects.atomic_notify_count == 1,
        "policy requires one initialization-guard notify"
    );
    ensure!(
        start_effects.atomic_wait_count == 1,
        "policy requires one initialization-guard wait"
    );
    ensure!(
        start_effects.memory_fill_count == 1,
        "policy requires one deterministic BSS fill"
    );
    ensure!(
        start_effects.memory_init.len() == passive_data.len(),
        "every passive data segment must be initialized exactly once"
    );
    ensure!(
        start_effects
            .memory_init
            .iter()
            .copied()
            .collect::<BTreeSet<_>>()
            == passive_data.keys().copied().collect::<BTreeSet<_>>(),
        "memory.init coverage differs from passive data segments"
    );
    ensure!(
        start_effects.data_drop == vec![1, 2],
        "policy requires LLVM TLS segment 0 retained and segments 1/2 dropped"
    );
    ensure!(
        passive_data.len() == 3,
        "policy expects LLVM TLS/data/BSS passive segment layout"
    );

    let memory_base_import = imported_globals
        .iter()
        .enumerate()
        .find(|(_, (module, name, ty))| {
            module == "env"
                && name == "__memory_base"
                && !ty.mutable
                && ty.content_type == wasmparser::ValType::I32
        })
        .map(|(index, _)| index as u32)
        .context("missing immutable i32 env.__memory_base import")?;
    let all_gets = closure
        .iter()
        .flat_map(|index| bodies[index].effects.global_gets.iter().copied())
        .collect::<BTreeSet<_>>();
    let all_sets = closure
        .iter()
        .flat_map(|index| bodies[index].effects.global_sets.iter().copied())
        .collect::<BTreeSet<_>>();
    ensure!(
        all_gets
            .iter()
            .all(|index| { *index == memory_base_import || all_sets.contains(index) }),
        "start closure reads a global not derived from __memory_base"
    );
    ensure!(
        all_sets
            .iter()
            .all(|index| *index >= imported_globals.len() as u32),
        "start closure mutates an imported global"
    );
    ensure!(
        !all_sets.is_empty(),
        "policy requires local numeric relocation globals"
    );

    let mut proof_hasher = Sha256::new();
    proof_hasher.update(POLICY.as_bytes());
    proof_hasher.update([0]);
    proof_hasher.update(module_sha256.as_bytes());
    for index in &closure {
        let body = &bodies[index];
        proof_hasher.update(index.to_le_bytes());
        proof_hasher.update((body.range.len() as u64).to_le_bytes());
        proof_hasher.update(&bytes[body.range.clone()]);
    }

    let proof = Proof {
        schema: PROOF_SCHEMA,
        analyzer_policy: POLICY,
        module_sha256,
        proof_sha256: hex::encode(proof_hasher.finalize()),
        start_function_index: start,
        start_function_export: START_EXPORT,
        transitive_function_indices: closure.into_iter().collect(),
        imported_function_calls: 0,
        memory_reads: "fresh-zero-atomic-guard-only",
        memory_effects: "passive-data-init-zero-fill-atomic-guard-only",
        global_effects: "local-numeric-relocations-only",
        table_effects: "none",
        requires_fresh_zeroed_memory: true,
        ordinary_start_execution_per_instance: true,
        first_instance_full_byte_validation: true,
    };
    serde_json::to_writer_pretty(std::io::stdout().lock(), &proof)?;
    println!();
    Ok(())
}

fn analyze_body(body: wasmparser::FunctionBody<'_>) -> Result<Effects> {
    let mut effects = Effects {
        allowed: true,
        ..Effects::default()
    };
    for operator in body.get_operators_reader()? {
        let operator = operator?;
        match operator {
            Operator::GlobalGet { global_index } => {
                effects.global_gets.insert(global_index);
            }
            Operator::GlobalSet { global_index } => {
                effects.global_sets.insert(global_index);
            }
            Operator::Call { function_index } => {
                let count = effects.calls.entry(function_index).or_default();
                *count = count.checked_add(1).context("direct call count overflow")?;
            }
            Operator::MemoryInit { data_index, mem: 0 } => effects.memory_init.push(data_index),
            Operator::DataDrop { data_index } => effects.data_drop.push(data_index),
            Operator::MemoryFill { mem: 0 } => effects.memory_fill_count += 1,
            Operator::I32AtomicRmwCmpxchg { memarg }
                if memarg.memory == 0 && memarg.offset == 0 && memarg.align == 2 =>
            {
                effects.cmpxchg_count += 1;
            }
            Operator::I32AtomicStore { memarg }
                if memarg.memory == 0 && memarg.offset == 0 && memarg.align == 2 =>
            {
                effects.atomic_store_count += 1;
            }
            Operator::MemoryAtomicNotify { memarg }
                if memarg.memory == 0 && memarg.offset == 0 && memarg.align == 2 =>
            {
                effects.atomic_notify_count += 1;
            }
            Operator::MemoryAtomicWait32 { memarg }
                if memarg.memory == 0 && memarg.offset == 0 && memarg.align == 2 =>
            {
                effects.atomic_wait_count += 1;
            }
            Operator::Block { .. } => effects.block_count += 1,
            Operator::Br { .. } => effects.br_count += 1,
            Operator::BrTable { .. } => effects.br_table_count += 1,
            Operator::I32Const { .. }
            | Operator::I64Const { .. }
            | Operator::I32Add
            | Operator::LocalGet { .. }
            | Operator::LocalSet { .. }
            | Operator::LocalTee { .. }
            | Operator::Drop
            | Operator::End => {}
            rejected => {
                effects.allowed = false;
                effects.rejection = Some(format!("{rejected:?}"));
                break;
            }
        }
    }
    Ok(effects)
}

fn has_call_cycle(
    start: u32,
    closure: &BTreeSet<u32>,
    bodies: &BTreeMap<u32, BodySummary>,
) -> Result<bool> {
    fn visit(
        index: u32,
        closure: &BTreeSet<u32>,
        bodies: &BTreeMap<u32, BodySummary>,
        visiting: &mut BTreeSet<u32>,
        visited: &mut BTreeSet<u32>,
    ) -> Result<bool> {
        if visiting.contains(&index) {
            return Ok(true);
        }
        if !visited.insert(index) {
            return Ok(false);
        }
        visiting.insert(index);
        for called in bodies
            .get(&index)
            .context("missing call-graph body")?
            .effects
            .calls
            .keys()
        {
            ensure!(
                closure.contains(called),
                "call graph escaped analyzed closure"
            );
            if visit(*called, closure, bodies, visiting, visited)? {
                return Ok(true);
            }
        }
        visiting.remove(&index);
        Ok(false)
    }

    visit(
        start,
        closure,
        bodies,
        &mut BTreeSet::new(),
        &mut BTreeSet::new(),
    )
}

fn validate_call_shape(
    start: u32,
    closure: &BTreeSet<u32>,
    bodies: &BTreeMap<u32, BodySummary>,
) -> Result<()> {
    ensure!(
        closure.len() == 2,
        "LLVM init policy expects start plus one relocation helper"
    );
    ensure!(
        !has_call_cycle(start, closure, bodies)?,
        "start call graph is cyclic"
    );
    let helper = *closure
        .iter()
        .find(|index| **index != start)
        .context("relocation helper is missing")?;
    let start_effects = &bodies
        .get(&start)
        .context("start function body is missing")?
        .effects;
    let helper_effects = &bodies
        .get(&helper)
        .context("relocation helper body is missing")?
        .effects;
    ensure!(
        start_effects.calls == BTreeMap::from([(helper, 1)]),
        "start must call only its relocation helper exactly once"
    );
    ensure!(
        helper_effects.calls.is_empty(),
        "relocation helper must be a leaf"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn first_body_effects(wat_source: &str) -> Effects {
        let bytes = wat::parse_str(wat_source).unwrap();
        for payload in Parser::new(0).parse_all(&bytes) {
            if let Payload::CodeSectionEntry(body) = payload.unwrap() {
                return analyze_body(body).unwrap();
            }
        }
        panic!("fixture has no function body");
    }

    #[test]
    fn policy_rejects_memory_reads() {
        let effects =
            first_body_effects("(module (memory 1) (func (drop (i32.load (i32.const 0)))))");
        assert!(!effects.allowed);
        assert!(effects.rejection.unwrap().starts_with("I32Load"));
    }

    #[test]
    fn policy_rejects_indirect_calls_and_table_effects() {
        let indirect = first_body_effects(
            "(module (type (func)) (table 1 funcref) (func (call_indirect (type 0) (i32.const 0))))",
        );
        assert!(!indirect.allowed);
        assert!(indirect.rejection.unwrap().starts_with("CallIndirect"));

        let table = first_body_effects("(module (table 1 funcref) (func (drop (table.size 0))))");
        assert!(!table.allowed);
        assert!(table.rejection.unwrap().starts_with("TableSize"));
    }

    #[test]
    fn policy_rejects_unrecognized_atomic_reads() {
        let effects = first_body_effects(
            "(module (memory 1 1 shared) (func (drop (i32.atomic.load (i32.const 0)))))",
        );
        assert!(!effects.allowed);
        assert!(effects.rejection.unwrap().starts_with("I32AtomicLoad"));
    }

    #[test]
    fn call_graph_cycle_is_rejected() {
        let mut bodies = BTreeMap::new();
        let mut first = Effects {
            allowed: true,
            ..Effects::default()
        };
        first.calls.insert(11, 1);
        let mut second = Effects {
            allowed: true,
            ..Effects::default()
        };
        second.calls.insert(10, 1);
        bodies.insert(
            10,
            BodySummary {
                range: 0..0,
                effects: first,
            },
        );
        bodies.insert(
            11,
            BodySummary {
                range: 0..0,
                effects: second,
            },
        );
        assert!(has_call_cycle(10, &BTreeSet::from([10, 11]), &bodies).unwrap());
    }

    #[test]
    fn duplicate_relocation_helper_call_is_rejected() {
        let mut bodies = BTreeMap::new();
        let mut start = Effects {
            allowed: true,
            ..Effects::default()
        };
        start.calls.insert(11, 2);
        bodies.insert(
            10,
            BodySummary {
                range: 0..0,
                effects: start,
            },
        );
        bodies.insert(
            11,
            BodySummary {
                range: 0..0,
                effects: Effects {
                    allowed: true,
                    ..Effects::default()
                },
            },
        );

        let error = validate_call_shape(10, &BTreeSet::from([10, 11]), &bodies)
            .unwrap_err()
            .to_string();
        assert!(error.contains("exactly once"), "unexpected error: {error}");
    }
}

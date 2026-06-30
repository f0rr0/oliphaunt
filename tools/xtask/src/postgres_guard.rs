use super::*;
use crate::source_spine::source_checkout_path;

pub(crate) fn check_wasix_shell_script_syntax() -> Result<()> {
    for script in wasix_build_shell_scripts()? {
        let mut command = Command::new("bash");
        command.arg("-n").arg(&script);
        run_command(&mut command).with_context(|| format!("syntax check {}", script.display()))?;
    }
    Ok(())
}

pub(crate) fn wasix_build_shell_scripts() -> Result<Vec<PathBuf>> {
    let mut scripts = sorted_children(Path::new(WASIX_BUILD_SOURCE_ROOT))?
        .into_iter()
        .filter(|path| path.is_file())
        .filter(|path| path.extension().and_then(|extension| extension.to_str()) == Some("sh"))
        .collect::<Vec<_>>();
    let external_root = Path::new("src/extensions/external");
    if external_root.exists() {
        for entry in WalkDir::new(external_root)
            .into_iter()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().is_file())
            .map(|entry| entry.into_path())
            .filter(|path| path.extension().and_then(|extension| extension.to_str()) == Some("sh"))
        {
            scripts.push(entry);
        }
    }
    scripts.sort();
    scripts.dedup();
    ensure!(
        !scripts.is_empty(),
        "WASIX build source root has no shell scripts: {WASIX_BUILD_SOURCE_ROOT}"
    );
    Ok(scripts)
}

pub(crate) fn check_postgres_source_spine() -> Result<()> {
    let manifest = load_postgres_source_manifest()?;
    ensure_eq(
        &manifest.postgresql.version,
        "18.4",
        "pinned PostgreSQL version",
    )?;
    ensure_eq(
        &manifest.postgresql.sha256,
        "81a81ec695fb0c7901407defaa1d2f7973617154cf27ba74e3a7ab8e64436094",
        "pinned PostgreSQL source sha256",
    )?;

    let series_text = fs::read_to_string(POSTGRES_PATCH_SERIES_PATH)
        .with_context(|| format!("read {POSTGRES_PATCH_SERIES_PATH}"))?;
    let series = series_text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect::<Vec<_>>();
    let file_series = series
        .iter()
        .map(|entry| (*entry).to_owned())
        .collect::<Vec<_>>();
    ensure!(
        manifest.patches.series == file_series,
        "{} [patches].series must exactly match {}",
        POSTGRES_SOURCE_MANIFEST_PATH,
        POSTGRES_PATCH_SERIES_PATH
    );
    check_prepared_postgres_source_if_present(&manifest)?;
    for required in [
        "0001-oliphaunt-wasix-add-wasix-dl-build-spine.patch",
        "0002-oliphaunt-wasix-add-backend-host-io-hooks.patch",
        "0003-oliphaunt-wasix-export-startup-packet-parser.patch",
        "0004-oliphaunt-wasix-add-host-lifecycle-exports.patch",
        "0005-oliphaunt-wasix-add-loop-pumped-protocol-exports.patch",
        "0006-oliphaunt-wasix-report-copy-protocol-state.patch",
        "0007-oliphaunt-wasix-add-wasix-pgxs-side-module-support.patch",
        "0008-oliphaunt-wasix-reset-copy-state-on-error-recovery.patch",
        "0009-oliphaunt-wasix-route-process-identity-through-port.patch",
        "0010-oliphaunt-wasix-route-sysv-shmem-through-port.patch",
        "0011-oliphaunt-wasix-prefer-posix-semaphores.patch",
        "0012-oliphaunt-wasix-capture-startup-errors.patch",
        "0013-oliphaunt-wasix-fail-active-portals-on-host-recovery.patch",
        "0014-oliphaunt-wasix-speed-up-hash-bytes-unaligned-loads.patch",
        "0015-oliphaunt-wasix-add-top-xid-current-transaction-fast-path.patch",
        "0016-oliphaunt-wasix-add-btree-int4-compare-fast-path.patch",
        "0017-oliphaunt-wasix-keep-btree-delete-scratch-on-stack.patch",
        "0018-oliphaunt-wasix-avoid-pg-dump-executequery-lto-collision.patch",
        "0019-oliphaunt-wasix-schedule-ready-after-host-recovery.patch",
        "0020-oliphaunt-wasix-rearm-exception-stack-after-host-recovery.patch",
        "0032-oliphaunt-wasix-avoid-xlog-size-checkpoint-requests.patch",
        "0033-oliphaunt-wasix-use-lightweight-embedded-runtime-paths.patch",
        "0034-oliphaunt-wasix-set-embedded-postmaster-environment.patch",
    ] {
        ensure!(
            series.contains(&required),
            "{} must list required PG18 WASIX patch {required}",
            POSTGRES_PATCH_SERIES_PATH
        );
    }

    let mut seen = BTreeSet::new();
    let mut combined_patch_text = String::new();
    let mut patch_texts = Vec::new();
    for patch_name in &series {
        ensure!(
            !patch_name.contains('/') && patch_name.ends_with(".patch"),
            "{} contains invalid PG18 patch entry {patch_name:?}",
            POSTGRES_PATCH_SERIES_PATH
        );
        ensure!(
            seen.insert(*patch_name),
            "{} contains duplicate PG18 patch entry {patch_name}",
            POSTGRES_PATCH_SERIES_PATH
        );
        let patch_path = Path::new(POSTGRES_PATCH_DIR).join(patch_name);
        ensure_file(&patch_path)?;
        let text = fs::read_to_string(&patch_path)
            .with_context(|| format!("read {}", patch_path.display()))?;
        combined_patch_text.push_str(&text);
        combined_patch_text.push('\n');
        patch_texts.push(((*patch_name).to_owned(), text));
    }
    check_postgres_patch_series_hygiene(&patch_texts)?;

    for entry in
        fs::read_dir(POSTGRES_PATCH_DIR).with_context(|| format!("read {POSTGRES_PATCH_DIR}"))?
    {
        let entry = entry.with_context(|| format!("read entry in {POSTGRES_PATCH_DIR}"))?;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("patch") {
            continue;
        }
        let patch_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| anyhow!("invalid PG18 patch filename {}", path.display()))?;
        ensure!(
            seen.contains(patch_name),
            "{} contains orphan patch file {} not listed in {}",
            POSTGRES_PATCH_DIR,
            patch_name,
            POSTGRES_PATCH_SERIES_PATH
        );
    }

    for banned in [
        concat!("__PG", "LITE__"),
        concat!("PG", "LITE_WASIX_DL"),
        concat!("PG", "LITE_HOST_EXPORT"),
        concat!("postgres-", "pg", "lite"),
        concat!("postgres-", "pg", "lite-wasix-src"),
        concat!("REL_17_5-", "pg", "lite"),
        "prepare_patched_source.sh",
        "ProcessStartupPacket: STUB",
        "need_tas=no",
        "--disable-spinlocks",
    ] {
        ensure!(
            !combined_patch_text.contains(banned),
            "PG18 WASIX patch stack must not inherit released Oliphaunt marker {banned:?}"
        );
    }

    check_postgres_host_export_surface(&combined_patch_text)?;
    check_postgres_legacy_symbol_leaks(&manifest)?;
    check_postgres_released_lane_boundary()?;
    ensure_pg18_experiment_patch_disposition()?;

    ensure_file_contains_all(
        POSTGRES_PREPARE_SCRIPT,
        &[
            "source_has_patch_artifacts",
            "patch --no-backup-if-mismatch -p1",
            "*.orig",
            "*.rej",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/configure_wasix_dl.sh",
        &[
            "prepare_postgres_source.sh",
            "--with-template=wasix-dl",
            "OLIPHAUNT_SHIM",
            "-sMODULE_KIND=dynamic-main",
            "-Dlongjmp=oliphaunt_wasix_longjmp",
            "-Dsiglongjmp=oliphaunt_wasix_siglongjmp",
        ],
    )?;
    ensure_file_not_contains_any(
        "src/runtimes/liboliphaunt/wasix/assets/build/configure_wasix_dl.sh",
        &[
            concat!("__PG", "LITE__"),
            concat!("PG", "LITE_WASIX_DL"),
            concat!("PG", "LITE_HOST_EXPORT"),
            "--disable-spinlocks",
            "-Dgeteuid=oliphaunt_wasix_geteuid",
            "-Dgetuid=oliphaunt_wasix_getuid",
            "-Dgetegid=oliphaunt_wasix_getegid",
            "-Dgetgid=oliphaunt_wasix_getgid",
            "-Dgetpwuid=oliphaunt_wasix_getpwuid",
            "-Dshmget=oliphaunt_wasix_shmget",
            "-Dshmat=oliphaunt_wasix_shmat",
            "-Dshmdt=oliphaunt_wasix_shmdt",
            "-Dshmctl=oliphaunt_wasix_shmctl",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_oliphaunt.sh",
        &[
            ". \"$ROOT/source_lane.sh\"",
            "SOURCE_LANE=\"$(oliphaunt_wasix_source_lane)\"",
            "oliphaunt_wasix_default_build_dir \"$SOURCE_LANE\"",
            "oliphaunt_wasix_prepare_source_for_docker \"$SOURCE_LANE\"",
            "configure_wasix_dl.sh",
            "OLIPHAUNT_WASM_SOURCE_LANE=\"$SOURCE_LANE\"",
            ".oliphaunt-wasix-source-fingerprint",
            ".oliphaunt-wasix-postgres-version",
            ".oliphaunt-wasix-bridge-sha256",
            ".oliphaunt-wasix-build-profile",
            "make -s -j\"$JOBS\" -C \"$BUILD_DIR/src/backend\" oliphaunt",
            "/usr/sbin/zic",
            "src/timezone/compiled/UTC",
            "src/timezone/compiled/America/New_York",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_runtime_support.sh",
        &[
            "make -s -j\"$JOBS\" -C \"$BUILD_DIR/src/pl/plpgsql/src\" all",
            "make -s -j\"$JOBS\" -C \"$BUILD_DIR/src/backend/snowball\" all",
            "src/pl/plpgsql/src/plpgsql.so",
            "src/backend/snowball/dict_snowball.so",
            "src/backend/snowball/snowball_create.sql",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/source_lane.sh",
        &[
            "oliphaunt_wasix_generated_build_dir",
            "oliphaunt_wasix_scratch_build_dir",
            "$CONTAINER_GENERATED_ROOT/build",
            ".oliphaunt-wasix-source-fingerprint",
            ".oliphaunt-wasix-postgres-version",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_initdb.sh",
        &[
            "oliphaunt_wasix_scratch_build_dir",
            "wasix-initdb",
            "-Dgetegid=oliphaunt_wasix_getegid",
            "-Dgetgid=oliphaunt_wasix_getgid",
            "-Dgetpwuid_r=oliphaunt_wasix_getpwuid_r",
        ],
    )?;
    ensure_file_not_contains_any(
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_initdb.sh",
        &["$CONTAINER_GENERATED_ROOT/build/wasix-initdb"],
    )?;
    ensure_file_contains_all(
        "tools/xtask/src/asset_pipeline.rs",
        &["let control_file = extension_source.join(format!(\"{}.control\", extension.sql_name));"],
    )?;

    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/0002-oliphaunt-wasix-add-backend-host-io-hooks.patch",
        &[
            "OliphauntWasmHostIO",
            "oliphaunt_wasix_io",
            "secure_raw_read",
            "secure_raw_write",
            "WL_POSTMASTER_DEATH",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/0001-oliphaunt-wasix-add-wasix-dl-build-spine.patch",
        &[
            "src/template/wasix-dl",
            "DOLIPHAUNT_WASM_SINGLE_USER",
            "does not disable spinlocks",
            "oliphaunt: $(OBJS)",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/0004-oliphaunt-wasix-add-host-lifecycle-exports.patch",
        &[
            "OLIPHAUNT_WASM_HOST_EXPORT(\"oliphaunt_wasix_start\")",
            "OLIPHAUNT_WASM_HOST_EXPORT(\"oliphaunt_wasix_send_conn_data\")",
            "oliphaunt_wasix_process_startup_options",
            "ReadyForQuery(DestRemote)",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/0005-oliphaunt-wasix-add-loop-pumped-protocol-exports.patch",
        &[
            "OLIPHAUNT_WASM_HOST_EXPORT(\"PostgresMainLoopOnce\")",
            "OLIPHAUNT_WASM_HOST_EXPORT(\"PostgresMainLongJmp\")",
            "OLIPHAUNT_WASM_HOST_EXPORT(\"PostgresSendReadyForQueryIfNecessary\")",
            "PostgresSendReadyForQueryIfNecessary();",
            "PG_exception_stack = &postgresmain_sigjmp_buf",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/0006-oliphaunt-wasix-report-copy-protocol-state.patch",
        &[
            "src/backend/commands/copyfromparse.c",
            "src/backend/commands/copyto.c",
            "src/backend/replication/walsender.c",
            "oliphaunt_wasix_protocol_report_copy_response(OLIPHAUNT_WASIX_PROTOCOL_COPY_IN)",
            "oliphaunt_wasix_protocol_report_copy_response(OLIPHAUNT_WASIX_PROTOCOL_COPY_OUT)",
            "oliphaunt_wasix_protocol_report_copy_response(OLIPHAUNT_WASIX_PROTOCOL_COPY_BOTH)",
            "extern void oliphaunt_wasix_protocol_report_copy_response(int state)",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/0007-oliphaunt-wasix-add-wasix-pgxs-side-module-support.patch",
        &[
            "src/makefiles/Makefile.wasix-dl",
            "WASM_DL_NM ?= wasixnm",
            "wasm_dl_extension_imports_dir := $(wasm_dl_extension_dir)/imports",
            "$(DESTDIR)$(wasm_dl_extension_imports_dir)",
            "for mod in $(MODULES); do",
            "PORTNAME=wasix-dl",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/0008-oliphaunt-wasix-reset-copy-state-on-error-recovery.patch",
        &[
            "PostgresMainLongJmp",
            "pq_comm_reset();",
            "oliphaunt_wasix_protocol_report_copy_response(OLIPHAUNT_WASIX_PROTOCOL_COPY_NONE)",
            "before the ErrorResponse is written",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/0009-oliphaunt-wasix-route-process-identity-through-port.patch",
        &[
            "src/include/port/wasix-dl.h",
            "extern uid_t oliphaunt_wasix_geteuid(void)",
            "extern gid_t oliphaunt_wasix_getegid(void)",
            "extern int oliphaunt_wasix_getpwuid_r",
            "#define geteuid oliphaunt_wasix_geteuid",
            "#define getegid oliphaunt_wasix_getegid",
            "#define getpwuid_r oliphaunt_wasix_getpwuid_r",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/0010-oliphaunt-wasix-route-sysv-shmem-through-port.patch",
        &[
            "src/include/port/wasix-dl/sys/ipc.h",
            "src/include/port/wasix-dl/sys/shm.h",
            "extern int oliphaunt_wasix_shmget(key_t key, size_t size, int shmflg)",
            "#define shmget oliphaunt_wasix_shmget",
            "#define shmctl oliphaunt_wasix_shmctl",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/0011-oliphaunt-wasix-prefer-posix-semaphores.patch",
        &[
            "src/template/wasix-dl",
            "PREFERRED_SEMAPHORES=UNNAMED_POSIX",
            "PostgreSQL's POSIX templates",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/0012-oliphaunt-wasix-capture-startup-errors.patch",
        &[
            "InitPostgres()",
            "oliphaunt_wasix_begin_startup_error_capture",
            "oliphaunt_wasix_init_protocol_port()",
            "whereToSendOutput = DestRemote",
            "oliphaunt_wasix_startup_error_capture_active = 1",
            "extern volatile int oliphaunt_wasix_startup_error_capture_active",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/0013-oliphaunt-wasix-fail-active-portals-on-host-recovery.patch",
        &[
            "src/backend/utils/mmgr/portalmem.c",
            "AtAbort_Portals",
            "portal->status == PORTAL_ACTIVE",
            "is_oliphaunt_active != 0",
            "MarkPortalFailed(portal)",
            "extern volatile int is_oliphaunt_active",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/0014-oliphaunt-wasix-speed-up-hash-bytes-unaligned-loads.patch",
        &[
            "src/common/hashfn.c",
            "#if defined(__wasi__) && !defined(WORDS_BIGENDIAN)",
            "oliphaunt_wasix_hash_load32",
            "memcpy(&value, ptr, sizeof(value))",
            "hash_bytes_extended",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/0015-oliphaunt-wasix-add-top-xid-current-transaction-fast-path.patch",
        &[
            "src/backend/access/transam/xact.c",
            "TransactionIdIsCurrentTransactionId",
            "nParallelCurrentXids == 0",
            "s->parent == NULL",
            "s->state != TRANS_ABORT",
            "s->nChildXids == 0",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/0016-oliphaunt-wasix-add-btree-int4-compare-fast-path.patch",
        &[
            "src/backend/access/nbtree/nbtsearch.c",
            "#if defined(__wasi__) && defined(OLIPHAUNT_WASM_SINGLE_USER)",
            "INTEGER_BTREE_FAM_OID",
            "rel->rd_opcintype[i - 1] == INT4OID",
            "scankey->sk_collation == InvalidOid",
            "FunctionCall2Coll",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/0017-oliphaunt-wasix-keep-btree-delete-scratch-on-stack.patch",
        &[
            "src/backend/access/nbtree/nbtdedup.c",
            "src/backend/access/nbtree/nbtinsert.c",
            "TM_IndexDelete deltids[MaxTIDsPerBTreePage]",
            "TM_IndexStatus status[MaxTIDsPerBTreePage]",
            "#if !defined(__wasi__) || !defined(OLIPHAUNT_WASM_SINGLE_USER)",
            "palloc(MaxTIDsPerBTreePage * sizeof(TM_IndexDelete))",
            "palloc(MaxTIDsPerBTreePage * sizeof(TM_IndexStatus))",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/0018-oliphaunt-wasix-avoid-pg-dump-executequery-lto-collision.patch",
        &[
            "src/bin/pg_dump/connectdb.c",
            "src/bin/pg_dump/connectdb.h",
            "src/bin/pg_dump/pg_dumpall.c",
            "executeDumpQuery",
            "executeQuery LTO collision",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/0019-oliphaunt-wasix-schedule-ready-after-host-recovery.patch",
        &[
            "src/backend/tcop/postgres.c",
            "PostgresMainLongJmp",
            "Host-forced ERROR recovery",
            "send_ready_for_query = true",
            "if (!ignore_till_sync)",
            "skip-till-Sync",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/0020-oliphaunt-wasix-rearm-exception-stack-after-host-recovery.patch",
        &[
            "src/backend/tcop/postgres.c",
            "PostgresMainLongJmp",
            "PG_exception_stack = &postgresmain_sigjmp_buf",
            "top-level exception stack",
            "Host-forced recovery",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/0032-oliphaunt-wasix-avoid-xlog-size-checkpoint-requests.patch",
        &[
            "src/backend/access/transam/xlog.c",
            "src/backend/postmaster/checkpointer.c",
            "RequestCheckpoint(CHECKPOINT_CAUSE_XLOG)",
            "#ifndef OLIPHAUNT_WASM_SINGLE_USER",
            "if (!IsPostmasterEnvironment)",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/0033-oliphaunt-wasix-use-lightweight-embedded-runtime-paths.patch",
        &[
            "src/backend/port/posix_sema.c",
            "src/backend/utils/misc/guc.c",
            "PGSemaphoreReset",
            "sem_trywait(PG_SEM_REF(sema))",
            "ReportGUCOption",
            "guc_strdup(LOG, val)",
            "#ifndef OLIPHAUNT_WASM_SINGLE_USER",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/0034-oliphaunt-wasix-set-embedded-postmaster-environment.patch",
        &[
            "src/backend/tcop/postgres.c",
            "oliphaunt_wasix_start",
            "IsPostmasterEnvironment = true",
            "IsUnderPostmaster = true",
            "paired with the prior checkpoint patch",
        ],
    )?;
    ensure_file_contains_all(
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/postgres_mod.rs",
        &[
            "const DEFAULT_STARTUP_GUCS",
            "(\"log_checkpoints\", \"false\")",
            "(\"max_wal_senders\", \"0\")",
            "(\"wal_buffers\", \"4MB\")",
            "(\"min_wal_size\", \"80MB\")",
            "(\"shared_buffers\", \"128MB\")",
        ],
    )?;
    ensure_file_contains_all(
        WASIX_BRIDGE_PATH,
        &[
            "oliphaunt_wasix_startup_error_capture_active",
            "oliphaunt_wasix_protocol_report_copy_response",
            "oliphaunt_wasix_getegid",
            "oliphaunt_wasix_getpwuid_r",
            "oliphaunt_wasix_shmget",
            "oliphaunt_wasix_shmctl",
            "OLIPHAUNT_WASIX_PROTOCOL_COPY_IN",
            "OLIPHAUNT_WASIX_PROTOCOL_COPY_OUT",
            "OLIPHAUNT_WASIX_PROTOCOL_COPY_BOTH",
            "oliphaunt_wasix_protocol_stream_requested",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/assets/build/wasix_shim/oliphaunt_wasix_initdb_shim.c",
        &[
            "oliphaunt_wasix_getegid",
            "oliphaunt_wasix_getgid",
            "oliphaunt_wasix_getpwuid_r",
            "errno = ERANGE",
        ],
    )?;

    println!("PostgreSQL source-spine guard passed");
    Ok(())
}

fn check_postgres_host_export_surface(combined_patch_text: &str) -> Result<()> {
    for &export in PG18_POSTGRES_HOST_EXPORTS {
        let marker = format!("OLIPHAUNT_WASM_HOST_EXPORT(\"{export}\")");
        ensure!(
            combined_patch_text.contains(&marker),
            "PG18 patch stack must explicitly export PostgreSQL host ABI symbol {export}"
        );
    }
    Ok(())
}

fn check_postgres_legacy_symbol_leaks(manifest: &PostgresSourceManifest) -> Result<()> {
    let mut roots = vec![
        PathBuf::from(POSTGRES_SOURCE_MANIFEST_PATH),
        PathBuf::from(POSTGRES_PATCH_DIR),
        PathBuf::from(POSTGRES_PREPARE_SCRIPT),
        PathBuf::from("src/runtimes/liboliphaunt/wasix/assets/build/configure_wasix_dl.sh"),
        PathBuf::from("src/runtimes/liboliphaunt/wasix/assets/build/docker_oliphaunt.sh"),
        PathBuf::from(
            "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/postgres_mod.rs",
        ),
    ];

    let prepared_source = postgres_default_source_dir(manifest);
    if prepared_source.exists() {
        roots.push(prepared_source);
    }
    for generated_root in [Path::new(WASIX_POSTGRES_DOCKER_BUILD_DIR)] {
        if generated_root.exists() {
            roots.push(generated_root.to_path_buf());
        }
    }

    let banned = [
        concat!("__PG", "LITE__"),
        concat!("PG", "LITE_"),
        concat!("PG", "L_"),
        "pgl_",
        concat!("pgl_startPG", "lite"),
        concat!("pgl_setPG", "liteActive"),
        concat!("pg", "lite_"),
    ];
    let mut leaks = Vec::new();
    for root in roots {
        if !root.exists() {
            continue;
        }
        if root.is_file() {
            collect_pg18_legacy_symbol_leaks(&root, &banned, &mut leaks)?;
            continue;
        }
        for entry in WalkDir::new(&root) {
            let entry = entry.with_context(|| format!("walk {}", root.display()))?;
            if !entry.file_type().is_file() {
                continue;
            }
            collect_pg18_legacy_symbol_leaks(entry.path(), &banned, &mut leaks)?;
        }
    }

    ensure!(
        leaks.is_empty(),
        "PG18 WASIX runtime must not leak legacy fork ABI markers:\n{}",
        leaks.join("\n")
    );
    Ok(())
}

fn collect_pg18_legacy_symbol_leaks(
    path: &Path,
    banned: &[&str],
    leaks: &mut Vec<String>,
) -> Result<()> {
    if matches!(
        path.extension().and_then(|extension| extension.to_str()),
        Some("wasm")
            | Some("o")
            | Some("a")
            | Some("so")
            | Some("dylib")
            | Some("dll")
            | Some("zst")
    ) {
        return Ok(());
    }
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    if bytes.contains(&0) {
        return Ok(());
    }
    let Ok(text) = String::from_utf8(bytes) else {
        return Ok(());
    };
    for (line_no, line) in text.lines().enumerate() {
        for marker in banned {
            if line.contains(marker) {
                leaks.push(format!(
                    "{}:{} contains {marker:?}",
                    path.display(),
                    line_no + 1
                ));
            }
        }
    }
    Ok(())
}

fn check_postgres_patch_series_hygiene(patches: &[(String, String)]) -> Result<()> {
    ensure!(
        patches.len() == 38,
        "PG18 WASIX patch series should stay reviewable at exactly 38 audited patches; got {}",
        patches.len()
    );
    for (index, (patch_name, patch_text)) in patches.iter().enumerate() {
        let expected_prefix = format!("{:04}-oliphaunt-wasix-", index + 1);
        ensure!(
            patch_name.starts_with(&expected_prefix) && patch_name.ends_with(".patch"),
            "PG18 patch {patch_name} must use sequential prefix {expected_prefix}*.patch"
        );
        ensure!(
            !patch_text.contains("TODO") && !patch_text.contains("FIXME"),
            "PG18 patch {patch_name} must not carry TODO/FIXME placeholders"
        );
        ensure!(
            patch_text.contains("From: Oliphaunt Maintainers <dev@oliphaunt.dev>"),
            "PG18 patch {patch_name} must keep the Oliphaunt maintainer header"
        );
        let subject = patch_text
            .lines()
            .find_map(|line| line.strip_prefix("Subject: [PATCH] oliphaunt-wasix: "))
            .ok_or_else(|| anyhow!("PG18 patch {patch_name} is missing an Oliphaunt subject"))?;
        let expected_slug = patch_name
            .trim_end_matches(".patch")
            .trim_start_matches(&expected_prefix);
        let actual_slug = pg18_patch_subject_slug(subject);
        if patch_name != "0021-oliphaunt-wasix-declare-wasix-fork.patch" {
            ensure_eq(
                actual_slug.as_str(),
                expected_slug,
                &format!("PG18 patch {patch_name} subject slug"),
            )?;
        }
        let diff_start = patch_text
            .find("\ndiff --git ")
            .or_else(|| patch_text.find("\n---\n"))
            .ok_or_else(|| anyhow!("PG18 patch {patch_name} is missing a diff body"))?;
        let header_text = &patch_text[..diff_start];
        let rationale_lines = header_text
            .lines()
            .skip_while(|line| !line.starts_with("Subject: "))
            .skip(1)
            .filter(|line| {
                let line = line.trim();
                !line.is_empty()
                    && !line.starts_with("---")
                    && !line.starts_with("From:")
                    && !line.starts_with("Date:")
            })
            .count();
        ensure!(
            rationale_lines >= 2,
            "PG18 patch {patch_name} must include a short rationale before the diff"
        );
    }
    Ok(())
}

fn pg18_patch_subject_slug(subject: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;
    for ch in subject.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_was_dash = false;
        } else if ch == '/' {
            continue;
        } else if !last_was_dash {
            slug.push('-');
            last_was_dash = true;
        }
    }
    slug.trim_matches('-').to_owned()
}

fn check_prepared_postgres_source_if_present(manifest: &PostgresSourceManifest) -> Result<()> {
    let source = postgres_default_source_dir(manifest);
    if !source.exists() {
        return Ok(());
    }
    check_prepared_postgres_source(manifest, &source, Path::new(WASIX_POSTGRES_WORK_DIR))
}

pub(crate) fn check_prepared_postgres_source(
    manifest: &PostgresSourceManifest,
    source: &Path,
    work_root: &Path,
) -> Result<()> {
    ensure!(
        source.is_dir(),
        "prepared PG18 source path is not a directory: {}",
        source.display()
    );

    let version_path = source.join(".oliphaunt-wasix-postgres-version");
    let version = fs::read_to_string(&version_path)
        .with_context(|| format!("read {}", version_path.display()))?;
    ensure_eq(
        version.trim(),
        manifest.postgresql.version.as_str(),
        "prepared PG18 source version marker",
    )?;
    let expected_fingerprint = postgres_expected_source_fingerprint(manifest)?;
    let source_fingerprint_path = source.join(".oliphaunt-wasix-source-fingerprint");
    let source_fingerprint = fs::read_to_string(&source_fingerprint_path)
        .with_context(|| format!("read {}", source_fingerprint_path.display()))?;
    ensure_eq(
        source_fingerprint.trim(),
        &expected_fingerprint,
        "prepared PG18 source fingerprint marker",
    )?;
    let work_fingerprint_path = work_root.join(".source-fingerprint");
    let work_fingerprint = fs::read_to_string(&work_fingerprint_path)
        .with_context(|| format!("read {}", work_fingerprint_path.display()))?;
    ensure_eq(
        work_fingerprint.trim(),
        &expected_fingerprint,
        "prepared PG18 work fingerprint marker",
    )?;

    let mut artifacts = Vec::new();
    for entry in WalkDir::new(&source) {
        let entry = entry.with_context(|| format!("walk {}", source.display()))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if matches!(
            path.extension().and_then(|extension| extension.to_str()),
            Some("orig" | "rej")
        ) {
            artifacts.push(path.display().to_string());
        }
    }
    ensure!(
        artifacts.is_empty(),
        "prepared PG18 source contains patch backup/reject artifacts: {}",
        artifacts.join(", ")
    );

    check_postgres_packaging_inputs(&source)?;
    check_postgres_applied_runtime_abi(&source)?;
    check_postgres_applied_perf_patches(&source)?;

    Ok(())
}

pub(crate) fn postgres_default_source_dir(manifest: &PostgresSourceManifest) -> PathBuf {
    Path::new(WASIX_POSTGRES_WORK_DIR)
        .join("work")
        .join(format!(
            "postgresql-{}-oliphaunt-wasix-src",
            manifest.postgresql.version
        ))
}

pub(crate) fn postgres_work_root_for_source(source: &Path) -> Result<PathBuf> {
    let work_dir = source.parent().ok_or_else(|| {
        anyhow!(
            "prepared PG18 source path has no parent work directory: {}",
            source.display()
        )
    })?;
    let work_root = work_dir.parent().ok_or_else(|| {
        anyhow!(
            "prepared PG18 source path has no parent work root: {}",
            source.display()
        )
    })?;
    Ok(work_root.to_path_buf())
}

pub(crate) fn postgres_expected_source_fingerprint(
    manifest: &PostgresSourceManifest,
) -> Result<String> {
    Ok(format!(
        "{}:{}:{}",
        manifest.postgresql.version,
        manifest.postgresql.sha256,
        postgres_patch_series_hash()?
    ))
}

fn postgres_patch_series_hash() -> Result<String> {
    let mut hasher = Sha256::new();
    for path in postgres_fingerprint_inputs()? {
        let hash = sha256_text_file_lf(&path)?;
        hasher.update(hash.as_bytes());
        hasher.update(b"\n");
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn postgres_fingerprint_inputs() -> Result<Vec<PathBuf>> {
    let mut paths = vec![repo_relative_path(POSTGRES_PATCH_SERIES_PATH)];
    for entry in sorted_children(&repo_relative_path(POSTGRES_PATCH_DIR))? {
        if entry.extension().and_then(|extension| extension.to_str()) == Some("patch") {
            paths.push(entry);
        }
    }
    Ok(paths)
}

fn check_postgres_applied_runtime_abi(source: &Path) -> Result<()> {
    ensure_file_contains_all(
        source.join("src/include/port/wasix-dl.h"),
        &[
            "extern sigjmp_buf postgresmain_sigjmp_buf",
            "extern ssize_t oliphaunt_wasix_host_read",
            "extern ssize_t oliphaunt_wasix_host_write",
            "extern void oliphaunt_wasix_process_startup_options",
            "extern volatile int oliphaunt_wasix_startup_error_capture_active",
            "OLIPHAUNT_WASIX_PROTOCOL_COPY_IN",
            "OLIPHAUNT_WASIX_PROTOCOL_COPY_OUT",
            "OLIPHAUNT_WASIX_PROTOCOL_COPY_BOTH",
            "extern void oliphaunt_wasix_protocol_report_copy_response(int state)",
        ],
    )?;
    ensure_file_contains_all(
        source.join("src/include/libpq/libpq-be.h"),
        &[
            "typedef struct OliphauntWasmHostIO",
            "(*read) (void *context, void *ptr, size_t len)",
            "(*write) (void *context, const void *ptr, size_t len)",
            "OliphauntWasmHostIO *oliphaunt_wasix_io",
        ],
    )?;
    ensure_file_contains_all(
        source.join("src/backend/libpq/be-secure.c"),
        &[
            "port->oliphaunt_wasix_io != NULL",
            "port->oliphaunt_wasix_io->read",
            "port->oliphaunt_wasix_io->write",
        ],
    )?;
    ensure_file_contains_all(
        source.join("src/backend/tcop/backend_startup.c"),
        &[
            "OLIPHAUNT_WASM_HOST_EXPORT(\"ProcessStartupPacket\") int",
            "ProcessStartupPacket(Port *port, bool ssl_done, bool gss_done)",
        ],
    )?;
    ensure_file_contains_all(
        source.join("src/backend/tcop/postgres.c"),
        &[
            "OLIPHAUNT_WASM_HOST_EXPORT(\"oliphaunt_wasix_start\")",
            "OLIPHAUNT_WASM_HOST_EXPORT(\"oliphaunt_wasix_pq_flush\")",
            "OLIPHAUNT_WASM_HOST_EXPORT(\"oliphaunt_wasix_get_proc_port\")",
            "OLIPHAUNT_WASM_HOST_EXPORT(\"oliphaunt_wasix_send_conn_data\")",
            "oliphaunt_wasix_init_protocol_port",
            "oliphaunt_wasix_process_startup_options(MyProcPort)",
            "ReadyForQuery(DestRemote)",
            "oliphaunt_wasix_startup_error_capture_active = 1",
            "OLIPHAUNT_WASM_HOST_EXPORT(\"PostgresSendReadyForQueryIfNecessary\")",
            "OLIPHAUNT_WASM_HOST_EXPORT(\"PostgresMainLongJmp\")",
            "OLIPHAUNT_WASM_HOST_EXPORT(\"PostgresMainLoopOnce\")",
            "oliphaunt_wasix_protocol_report_copy_response(OLIPHAUNT_WASIX_PROTOCOL_COPY_NONE)",
            "PG_exception_stack = &postgresmain_sigjmp_buf",
            "if (!ignore_till_sync)",
            "send_ready_for_query = true",
        ],
    )?;
    ensure_file_contains_all(
        source.join("src/backend/commands/copyfromparse.c"),
        &["oliphaunt_wasix_protocol_report_copy_response(OLIPHAUNT_WASIX_PROTOCOL_COPY_IN)"],
    )?;
    ensure_file_contains_all(
        source.join("src/backend/commands/copyto.c"),
        &["oliphaunt_wasix_protocol_report_copy_response(OLIPHAUNT_WASIX_PROTOCOL_COPY_OUT)"],
    )?;
    ensure_file_contains_all(
        source.join("src/backend/replication/walsender.c"),
        &[
            "oliphaunt_wasix_protocol_report_copy_response(OLIPHAUNT_WASIX_PROTOCOL_COPY_IN)",
            "oliphaunt_wasix_protocol_report_copy_response(OLIPHAUNT_WASIX_PROTOCOL_COPY_BOTH)",
        ],
    )?;
    ensure_file_contains_all(
        source.join("src/backend/utils/mmgr/portalmem.c"),
        &[
            "portal->status == PORTAL_ACTIVE",
            "is_oliphaunt_active != 0",
            "MarkPortalFailed(portal)",
        ],
    )?;
    ensure_file_contains_all(
        WASIX_BRIDGE_PATH,
        &[
            "oliphaunt_wasix_set_active",
            "oliphaunt_wasix_set_force_host_error_recovery",
            "oliphaunt_wasix_set_protocol_stdio",
            "oliphaunt_wasix_set_protocol_transport",
            "oliphaunt_wasix_protocol_stream_active",
            "oliphaunt_wasix_input_reset",
            "oliphaunt_wasix_input_write",
            "oliphaunt_wasix_input_available",
            "oliphaunt_wasix_output_reset",
            "oliphaunt_wasix_output_len",
            "oliphaunt_wasix_output_read",
        ],
    )?;
    Ok(())
}

fn check_postgres_applied_perf_patches(source: &Path) -> Result<()> {
    ensure_file_contains_all(
        source.join("src/common/hashfn.c"),
        &[
            "oliphaunt_wasix_hash_load32",
            "memcpy(&value, ptr, sizeof(value))",
            "hash_bytes_extended",
        ],
    )?;
    ensure_file_contains_all(
        source.join("src/backend/access/transam/xact.c"),
        &[
            "nParallelCurrentXids == 0",
            "s->parent == NULL",
            "s->nChildXids == 0",
        ],
    )?;
    ensure_file_contains_all(
        source.join("src/backend/access/nbtree/nbtsearch.c"),
        &[
            "#if defined(__wasi__) && defined(OLIPHAUNT_WASM_SINGLE_USER)",
            "INTEGER_BTREE_FAM_OID",
            "rel->rd_opcintype[i - 1] == INT4OID",
            "FunctionCall2Coll",
        ],
    )?;
    ensure_file_contains_all(
        source.join("src/backend/access/nbtree/nbtdedup.c"),
        &[
            "TM_IndexDelete deltids[MaxTIDsPerBTreePage]",
            "TM_IndexStatus status[MaxTIDsPerBTreePage]",
            "#if !defined(__wasi__) || !defined(OLIPHAUNT_WASM_SINGLE_USER)",
        ],
    )?;
    ensure_file_contains_all(
        source.join("src/backend/access/nbtree/nbtinsert.c"),
        &[
            "TM_IndexDelete deltids[MaxTIDsPerBTreePage]",
            "TM_IndexStatus status[MaxTIDsPerBTreePage]",
            "#if !defined(__wasi__) || !defined(OLIPHAUNT_WASM_SINGLE_USER)",
        ],
    )?;
    ensure_file_contains_all(
        source.join("src/bin/pg_dump/connectdb.c"),
        &["executeDumpQuery(PGconn *conn, const char *query)"],
    )?;
    ensure_file_contains_all(
        source.join("src/bin/pg_dump/connectdb.h"),
        &["extern PGresult *executeDumpQuery(PGconn *conn, const char *query)"],
    )?;
    ensure_file_contains_all(
        source.join("src/bin/pg_dump/pg_dumpall.c"),
        &["executeDumpQuery(conn"],
    )?;
    ensure_file_contains_all(
        source.join("src/backend/tcop/postgres.c"),
        &[
            "#ifndef OLIPHAUNT_WASM_SINGLE_USER",
            "pgstat_report_query_id(0, true)",
            "pgstat_report_query_id(query->queryId, false)",
            "pgstat_report_query_id(stmt->queryId, false)",
            "pgstat_report_plan_id(0, true)",
            "pgstat_report_plan_id(plan->planId, false)",
            "pgstat_report_plan_id(stmt->planId, false)",
        ],
    )?;
    ensure_file_contains_all(
        source.join("src/backend/optimizer/plan/planner.c"),
        &[
            "#ifndef OLIPHAUNT_WASM_SINGLE_USER",
            "pgstat_report_plan_id(result->planId, false)",
        ],
    )?;
    Ok(())
}

pub(crate) fn check_source_lane_isolation() -> Result<()> {
    ensure!(
        canonical_source_lane("pg17").is_err(),
        "legacy PG17 source lane must not remain selectable after PG18 promotion"
    );
    ensure_eq(
        canonical_source_lane("released")?,
        DEFAULT_SOURCE_LANE,
        "canonical stable released alias",
    )?;
    ensure_eq(
        canonical_source_lane("stable")?,
        "stable",
        "canonical PG18 source lane",
    )?;
    ensure!(
        build_output_manifest_paths_for_source_lane(DEFAULT_SOURCE_LANE)?
            .contains(&Path::new(WASIX_BUILD_MANIFEST_PATH)),
        "stable PG18 build output manifest fallback path drifted"
    );
    ensure!(
        build_output_manifest_path_for_source_lane(DEFAULT_SOURCE_LANE)?
            == Path::new(WASIX_POSTGRES_BUILD_MANIFEST_PATH),
        "stable PG18 build output manifest path drifted"
    );
    ensure!(
        generated_assets_dir_for_source_lane(DEFAULT_SOURCE_LANE)?
            == Path::new(GENERATED_ASSETS_DIR),
        "stable portable asset path drifted"
    );
    ensure!(
        generated_aot_source_dir_for_source_lane("aarch64", "stable")?
            == Path::new(WASIX_POSTGRES_GENERATED_BUILD_DIR)
                .join("aot")
                .join("aarch64"),
        "PG18 AOT source path drifted"
    );
    ensure!(
        generated_aot_dir_for_source_lane("aarch64", DEFAULT_SOURCE_LANE)?
            == Path::new(GENERATED_AOT_DIR).join("aarch64"),
        "stable AOT artifact path drifted"
    );

    let extension_catalog = fs::read_to_string("tools/xtask/src/extension_catalog.rs")
        .context("read tools/xtask/src/extension_catalog.rs for source-lane isolation guard")?;
    for marker in [
        "manifest_metadata_by_sql_name_from_generated_plan",
        "extension_discovery_inputs_available(false)?",
        "extension discovery inputs are unavailable, so generated build plan fallback is required",
    ] {
        ensure!(
            extension_catalog.contains(marker),
            "extension catalog source-lane isolation guard is missing marker {marker:?}"
        );
    }
    let source_lane_sh =
        fs::read_to_string("src/runtimes/liboliphaunt/wasix/assets/build/source_lane.sh")
            .context("read src/runtimes/liboliphaunt/wasix/assets/build/source_lane.sh")?;
    for marker in [
        "PG18 build source fingerprint mismatch",
        "PG18 build PostgreSQL version marker mismatch",
    ] {
        ensure!(
            source_lane_sh.contains(marker),
            "source_lane.sh must fail closed with marker {marker:?}"
        );
    }
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml",
        &[
            "include = [",
            "\"payload/**\"",
            "[dependencies]",
            "serde_json = \"1\"",
        ],
    )?;
    let asset_build_rs =
        fs::read_to_string("src/runtimes/liboliphaunt/wasix/crates/assets/build.rs")
            .context("read src/runtimes/liboliphaunt/wasix/crates/assets/build.rs")?;
    for marker in [
        "OLIPHAUNT_WASM_GENERATED_ASSETS_DIR",
        "repo_root_from_manifest_dir",
        "src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml",
        "target/oliphaunt-wasix/assets",
        "manifest_dir.join(\"payload\")",
        "write_source_only_assets",
        "source-only-template",
    ] {
        ensure!(
            asset_build_rs.contains(marker),
            "asset crate source-only build script guard is missing marker {marker:?}"
        );
    }
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/crates/tools/build.rs",
        &[
            "oliphaunt-wasix-tools",
            "pg_dump_wasm",
            "psql_wasm",
            "bin/pg_dump.wasix.wasm",
            "bin/psql.wasix.wasm",
        ],
    )?;
    for marker in [
        "OLIPHAUNT_WASM_SOURCE_LANE",
        "validate_asset_manifest_source_lane",
        "is_released_source_lane",
        "unsupported OLIPHAUNT_WASM_SOURCE_LANE",
    ] {
        ensure!(
            !asset_build_rs.contains(marker),
            "asset crate build script must not keep source-lane asset selection marker {marker:?}"
        );
    }
    ensure_file_contains_all(
        "tools/xtask/src/asset_pipeline.rs",
        &[
            "stage_recipe_staged_extension(build, extension, stage)",
            "archive must not include excluded extension control file",
        ],
    )?;
    ensure_file_contains_all(
        "src/runtimes/liboliphaunt/wasix/crates/assets/src/lib.rs",
        &[
            "pub source_fingerprint: Option<String>",
            "pg18_manifest_metadata_round_trips",
        ],
    )?;
    ensure_file_contains_all(
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/assets.rs",
        &[
            "asset_manifest_metadata",
            "pgdata_template_source_fingerprint",
        ],
    )?;
    ensure_file_contains_all(
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/lib.rs",
        &["AssetManifestMetadata", "asset_manifest_metadata"],
    )?;
    ensure_file_contains_all(
        "tools/perf/runner/src/report.rs",
        &[
            "WasixRuntimeAssetReport",
            "wasix_runtime_assets",
            "asset_manifest_metadata",
            "source_lane: metadata",
            "pgdata_template_source_fingerprint",
        ],
    )?;
    ensure_file_contains_all(
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/base.rs",
        &[
            "pub source_fingerprint: Option<String>",
            "embedded PGDATA template source fingerprint mismatch",
            "full_runtime_layout_matches_current",
            "ensure_existing_pgdata_matches_runtime",
            "existing PGDATA at {} is PostgreSQL {}",
            "source-fingerprint=",
        ],
    )?;
    ensure_file_contains_all(
        "src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/aot.rs",
        &[
            "source_fingerprint: Option<String>",
            "AOT manifest source fingerprint mismatch",
            "AOT manifest is missing postgres-version metadata",
        ],
    )?;
    check_postgres_released_lane_boundary()?;
    println!("stable source isolation guard passed");
    Ok(())
}

fn check_postgres_released_lane_boundary() -> Result<()> {
    let pg18_owned_files = [
        POSTGRES_SOURCE_MANIFEST_PATH,
        POSTGRES_PREPARE_SCRIPT,
        "src/runtimes/liboliphaunt/wasix/assets/build/configure_wasix_dl.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/docker_oliphaunt.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/wasix_third_party.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_openssl.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_sqlite.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_geos.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_libxml2.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_jsonc.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_proj.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_libiconv.sh",
        "src/runtimes/liboliphaunt/wasix/assets/build/build_wasix_icu.sh",
        "src/extensions/external/postgis/tools/build_wasix.sh",
    ];
    let released_lane_markers = [
        WASIX_PATCHED_SOURCE_DIR,
        "prepare_patched_source.sh",
        concat!("__PG", "LITE__"),
        concat!("PG", "LITE_WASIX_DL"),
        concat!("PG", "LITE_HOST_EXPORT"),
    ];

    let mut failures = Vec::new();
    for path in pg18_owned_files {
        let text = fs::read_to_string(path).with_context(|| format!("read {path}"))?;
        for marker in released_lane_markers {
            if text.contains(marker) {
                failures.push(format!(
                    "{path} must not depend on released PG17/Oliphaunt marker {marker:?}"
                ));
            }
        }
    }

    let source_lane_sh =
        fs::read_to_string("src/runtimes/liboliphaunt/wasix/assets/build/source_lane.sh")
            .context("read src/runtimes/liboliphaunt/wasix/assets/build/source_lane.sh")?;
    for marker in [
        "$CONTAINER_GENERATED_ROOT/work/docker-oliphaunt",
        "$CONTAINER_GENERATED_ROOT/build",
        "local host_pgsrc",
        "prepare_postgres_source.sh",
        "prepared PG18 source is outside repo mount",
    ] {
        if !source_lane_sh.contains(marker) {
            failures.push(format!(
                "source_lane.sh PG18 arm is missing lane-owned marker {marker:?}"
            ));
        }
    }

    if !failures.is_empty() {
        bail!("{}", failures.join("; "));
    }
    Ok(())
}

fn check_postgres_packaging_inputs(source: &Path) -> Result<()> {
    for required in [
        "src/bin/initdb/initdb.c",
        "src/bin/pg_dump/pg_dump.c",
        "src/bin/pg_dump/connectdb.c",
        "src/bin/pg_dump/connectdb.h",
        "src/pl/plpgsql/src/Makefile",
        "src/pl/plpgsql/src/plpgsql.control",
        "src/pl/plpgsql/src/plpgsql--1.0.sql",
        "src/pl/plpgsql/src/pl_handler.c",
        "src/backend/snowball/Makefile",
        "src/backend/snowball/dict_snowball.c",
        "src/backend/snowball/snowball_create.pl",
        "src/backend/snowball/snowball.sql.in",
        "src/backend/snowball/snowball_func.sql.in",
        "src/timezone/data/tzdata.zi",
        "src/timezone/tznames/Default",
    ] {
        ensure_file(&source.join(required))?;
    }

    let promoted_specs = extension_catalog::promoted_build_specs()?;
    for extension in promoted_specs
        .iter()
        .filter(|extension| extension.source_kind == "postgis")
    {
        let source_dir = Path::new(&extension.source_dir);
        ensure_file(&source_dir.join("configure.ac"))?;
        ensure_file(&source_dir.join("extensions/postgis/Makefile.in"))?;
        ensure_file(&source_dir.join("postgis/postgis.sql.in"))?;
        ensure_file(&source_dir.join("libpgcommon/sql/AddToSearchPath.sql.inc"))?;
    }

    let mut checked_contrib = 0usize;
    let mut missing = Vec::new();
    for extension in promoted_specs
        .iter()
        .filter(|extension| extension.build_kind == "postgres-contrib")
    {
        checked_contrib += 1;
        let Some(contrib_dir) = extension.contrib_dir.as_deref() else {
            missing.push(format!("{}: missing generated contrib_dir", extension.id));
            continue;
        };
        let extension_source = source.join("contrib").join(contrib_dir);
        if !extension_source.is_dir() {
            missing.push(format!(
                "{}: missing PG18 contrib source directory {}",
                extension.id,
                extension_source.display()
            ));
            continue;
        }
        let makefile = extension_source.join("Makefile");
        if !makefile.is_file() {
            missing.push(format!(
                "{}: missing PG18 contrib Makefile {}",
                extension.id,
                makefile.display()
            ));
        }
        if extension.lifecycle.create_extension || extension.control_file.is_some() {
            let control = extension_source.join(format!("{}.control", extension.sql_name));
            if !control.is_file() {
                missing.push(format!(
                    "{}: missing PG18 contrib control file {}",
                    extension.id,
                    control.display()
                ));
            }
        }
        if extension.lifecycle.create_extension
            && !extension_source_contains_packaged_sql(&extension_source, &extension.sql_name)?
        {
            missing.push(format!(
                "{}: missing PG18 contrib SQL file for CREATE EXTENSION {} in {}",
                extension.id,
                extension.sql_name,
                extension_source.display()
            ));
        }
    }

    ensure!(
        checked_contrib > 0,
        "PG18 packaging input guard did not find any promoted postgres-contrib extensions"
    );
    ensure!(
        missing.is_empty(),
        "PG18 prepared source is missing promoted contrib packaging inputs: {}",
        missing.join("; ")
    );
    check_postgres_pgxs_packaging_inputs()?;
    Ok(())
}

fn check_postgres_pgxs_packaging_inputs() -> Result<()> {
    let manifest = load_sources_manifest()?;
    let mut checked_pgxs = 0usize;
    let mut missing = Vec::new();
    for extension in extension_catalog::promoted_build_specs()?
        .iter()
        .filter(|extension| extension_catalog::is_pgxs_style_build_kind(&extension.build_kind))
    {
        checked_pgxs += 1;
        ensure!(
            extension
                .source_dir
                .starts_with("target/oliphaunt-sources/checkouts/"),
            "PG18 PGXS extension {} source dir must be lane-neutral under target/oliphaunt-sources/checkouts, got {}",
            extension.id,
            extension.source_dir
        );
        ensure!(
            !extension
                .source_dir
                .contains(concat!("postgres-", "pg", "lite")),
            "PG18 PGXS extension {} must not use removed fork source dir {}",
            extension.id,
            extension.source_dir
        );
        ensure!(
            source_pin_for_checkout_dir(&manifest, &extension.source_dir).is_some(),
            "PG18 PGXS extension {} source dir {} is not pinned in source metadata",
            extension.id,
            extension.source_dir
        );
        if let Some(module_file) = extension.module_file.as_deref() {
            ensure!(
                module_file.ends_with(".so"),
                "PG18 PGXS extension {} native module must be a WASIX side module name, got {}",
                extension.id,
                module_file
            );
        }

        let source = Path::new(&extension.source_dir);
        if !source.is_dir() {
            eprintln!(
                "warning: PG18 PGXS extension {} source checkout is missing at {}; run source-spine --strict-local after fetching shared extension checkouts",
                extension.id,
                source.display()
            );
            continue;
        }
        if !source.join("Makefile").is_file() {
            missing.push(format!(
                "{}: missing PGXS Makefile {}",
                extension.id,
                source.join("Makefile").display()
            ));
        }
        if extension.lifecycle.create_extension || extension.control_file.is_some() {
            let control_file = extension
                .control_file
                .as_deref()
                .map(Path::new)
                .filter(|path| path.is_file())
                .map(Path::to_path_buf)
                .unwrap_or_else(|| source.join(format!("{}.control", extension.sql_name)));
            if !control_file.is_file() {
                missing.push(format!(
                    "{}: missing PGXS control file {}",
                    extension.id,
                    control_file.display()
                ));
            }
        }
        if extension.lifecycle.create_extension
            && !pgxs_extension_source_contains_packaged_sql(source, &extension.sql_name)?
        {
            missing.push(format!(
                "{}: missing PGXS SQL file for CREATE EXTENSION {} in {} or {}/sql",
                extension.id,
                extension.sql_name,
                source.display(),
                source.display()
            ));
        }
    }

    ensure!(
        checked_pgxs > 0,
        "PG18 packaging input guard did not find any promoted PGXS external extensions"
    );
    ensure!(
        missing.is_empty(),
        "PG18 promoted PGXS packaging inputs are incomplete: {}",
        missing.join("; ")
    );
    Ok(())
}

fn extension_source_contains_packaged_sql(source: &Path, sql_name: &str) -> Result<bool> {
    if !source.is_dir() {
        return Ok(false);
    }
    for entry in sorted_children(source)? {
        if !entry.is_file() {
            continue;
        }
        let Some(name) = entry.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if (name.starts_with(&format!("{sql_name}--")) || name == format!("{sql_name}.sql"))
            && name.ends_with(".sql")
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn pgxs_extension_source_contains_packaged_sql(source: &Path, sql_name: &str) -> Result<bool> {
    if extension_source_contains_packaged_sql(source, sql_name)? {
        return Ok(true);
    }
    extension_source_contains_any_sql(&source.join("sql"))
}

fn extension_source_contains_any_sql(source: &Path) -> Result<bool> {
    if !source.is_dir() {
        return Ok(false);
    }
    for entry in sorted_children(source)? {
        if entry.extension().and_then(|extension| extension.to_str()) == Some("sql") {
            return Ok(true);
        }
    }
    Ok(false)
}

fn source_pin_for_checkout_dir<'a>(
    manifest: &'a SourcesManifest,
    source_dir: &str,
) -> Option<&'a SourcePin> {
    let expected = normalize_manifest_path(Path::new(source_dir));
    manifest.sources.iter().find(|source| {
        source_checkout_path(source.name.as_str())
            .map(|path| normalize_manifest_path(&path))
            .as_deref()
            == Some(expected.as_str())
    })
}

fn normalize_manifest_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn ensure_pg18_experiment_patch_disposition() -> Result<()> {
    let text = fs::read_to_string(POSTGRES_EXPERIMENT_DISPOSITION_PATH)
        .with_context(|| format!("read {POSTGRES_EXPERIMENT_DISPOSITION_PATH}"))?;
    for required in [
        "0001-wasix-use-posix-dsm-not-sysv.patch",
        "0003-wasix-libpq-static-encoding-shim.patch",
        "0004-wasix-core-execbackend-initdb-runtime.patch",
        "0005-pg-dump-avoid-lto-executequery-collision.patch",
        "0006-like-literal-substring-fast-path.patch",
        "0007-top-xid-current-transaction-fast-path.patch",
        "0008-btree-int4-compare-fast-path.patch",
        "0009-btree-delete-stack-state.patch",
        "0010-btree-bottomup-delete-runtime-toggle.patch",
        "0011-btree-first-int4-compare-fast-path.patch",
        "0012-hash-bytes-unaligned-load-fast-path.patch",
        "do-not-port-experiment-patches-without-a-recorded-wasix-runtime-rationale",
        "ported as 0014-oliphaunt-wasix-speed-up-hash-bytes-unaligned-loads.patch",
        "ported as 0015-oliphaunt-wasix-add-top-xid-current-transaction-fast-path.patch",
        "ported as 0016-oliphaunt-wasix-add-btree-int4-compare-fast-path.patch",
        "ported as 0017-oliphaunt-wasix-keep-btree-delete-scratch-on-stack.patch",
        "ported as 0018-oliphaunt-wasix-avoid-pg-dump-executequery-lto-collision.patch",
        "rejected-for-default-lane",
        "deferred",
    ] {
        ensure!(
            text.contains(required),
            "{} must record experiment patch disposition marker {required:?}",
            POSTGRES_EXPERIMENT_DISPOSITION_PATH
        );
    }
    for banned in ["adopt-without-review", "blind-port", "TODO decide"] {
        ensure!(
            !text.contains(banned),
            "{} contains unresolved experiment disposition marker {banned:?}",
            POSTGRES_EXPERIMENT_DISPOSITION_PATH
        );
    }

    let disposition_experiments = text
        .lines()
        .filter_map(|line| {
            line.trim()
                .strip_prefix("experiment = ")
                .and_then(parse_toml_string_literal)
        })
        .collect::<BTreeSet<_>>();
    let source_path = text
        .lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("source_path = ")
                .and_then(parse_toml_string_literal)
        })
        .ok_or_else(|| {
            anyhow!(
                "{} must record the source_path for the full-PG experiment patches",
                POSTGRES_EXPERIMENT_DISPOSITION_PATH
            )
        })?;
    let experiment_patch_dir = Path::new(&source_path);
    if experiment_patch_dir.is_dir() {
        let mut experiment_patches = BTreeSet::new();
        for entry in fs::read_dir(experiment_patch_dir)
            .with_context(|| format!("read {}", experiment_patch_dir.display()))?
        {
            let entry = entry
                .with_context(|| format!("read entry in {}", experiment_patch_dir.display()))?;
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("patch") {
                continue;
            }
            let patch_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| anyhow!("invalid experiment patch filename {}", path.display()))?;
            experiment_patches.insert(patch_name.to_owned());
        }
        ensure!(
            disposition_experiments == experiment_patches,
            "{} must exactly cover experiment patches under {}; missing={:?} stale={:?}",
            POSTGRES_EXPERIMENT_DISPOSITION_PATH,
            experiment_patch_dir.display(),
            experiment_patches
                .difference(&disposition_experiments)
                .collect::<Vec<_>>(),
            disposition_experiments
                .difference(&experiment_patches)
                .collect::<Vec<_>>()
        );
    }
    Ok(())
}

fn parse_toml_string_literal(value: &str) -> Option<String> {
    let value = value.trim().trim_end_matches(',');
    let value = value.strip_prefix('"')?.strip_suffix('"')?;
    Some(value.to_owned())
}

pub(crate) fn check_rust_startup_abi_boundary() -> Result<()> {
    let path =
        Path::new("src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/postgres_mod.rs");
    let text = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;

    for marker in [
        "struct OliphauntLifecycleExports",
        "struct WasixProtocolExports",
        "fn ensure_integrated_oliphaunt_contract",
        "fn record_backend_c_timings",
        "oliphaunt_wasix_backend_timing_reset",
        "oliphaunt_wasix_backend_timing_elapsed_us",
        "host_requires_process_exit_error_recovery",
        "oliphaunt_wasix_set_force_host_error_recovery",
        "oliphaunt_wasix_set_protocol_transport",
        "oliphaunt_wasix_protocol_stream_active",
        "The upstream lifecycle is already running by this point",
    ] {
        if !text.contains(marker) {
            bail!(
                "{} must keep upstream lifecycle exports separate from WASIX protocol ABI; missing {marker:?}",
                path.display()
            );
        }
    }
    if text.contains("struct Exports") {
        bail!(
            "{} must not collapse Oliphaunt lifecycle and WASIX protocol exports into a generic Exports struct",
            path.display()
        );
    }
    check_rust_host_runtime_abi_surface(&text)?;

    let lifecycle_start = text
        .find("struct OliphauntLifecycleExports")
        .ok_or_else(|| anyhow!("missing OliphauntLifecycleExports"))?;
    let protocol_start = text
        .find("struct WasixProtocolExports")
        .ok_or_else(|| anyhow!("missing WasixProtocolExports"))?;
    let lifecycle_block = &text[lifecycle_start..protocol_start];
    for protocol_marker in [
        "ProcessStartupPacket",
        "PostgresMainLoopOnce",
        "oliphaunt_wasix_input",
    ] {
        if lifecycle_block.contains(protocol_marker) {
            bail!(
                "{} lifecycle export block leaked WASIX protocol marker {protocol_marker:?}",
                path.display()
            );
        }
    }
    for lifecycle_marker in [
        "wasi_start",
        "set_force_host_error_recovery",
        "set_active",
        "start_oliphaunt",
    ] {
        if !lifecycle_block.contains(lifecycle_marker) {
            bail!(
                "{} must drive the integrated Oliphaunt lifecycle; missing {lifecycle_marker:?}",
                path.display()
            );
        }
    }

    println!("Rust startup ABI boundary guard passed");
    Ok(())
}

fn check_rust_host_runtime_abi_surface(postgres_mod: &str) -> Result<()> {
    let runtime_exports = required_runtime_abi_exports()
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    for &export in RUST_HOST_REQUIRED_RUNTIME_EXPORTS {
        ensure!(
            postgres_mod.contains(&format!("\"{export}\"")),
            "Rust WASIX host must load required runtime export {export}"
        );
        ensure!(
            runtime_exports.contains(export),
            "WASIX runtime export validator must require Rust host export {export}"
        );
    }
    for &export in RUST_HOST_OPTIONAL_RUNTIME_EXPORTS {
        ensure!(
            postgres_mod.contains(&format!("\"{export}\"")),
            "Rust WASIX host must consciously load optional runtime export {export}"
        );
    }
    for &export in RUNTIME_EXPORT_LIST_COMPAT_EXPORTS {
        ensure!(
            runtime_exports.contains(export),
            "WASIX runtime export validator must keep compatibility export {export}"
        );
    }
    for export in [
        "oliphaunt_wasix_set_force_host_error_recovery",
        "oliphaunt_wasix_set_protocol_transport",
    ] {
        ensure!(
            runtime_exports.contains(export),
            "WASIX runtime export validator must require optional Rust host export {export} for current generated assets"
        );
    }
    for legacy in [
        "oliphaunt_wasix_initdb",
        "oliphaunt_wasix_backend",
        "PostgresRecoverProtocolError",
    ] {
        ensure!(
            !postgres_mod.contains(&format!("\"{legacy}\"")),
            "Rust WASIX host must not load legacy builder-branch export {legacy}"
        );
    }
    Ok(())
}

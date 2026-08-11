#if canImport(OliphauntIOSBroker)
    import Darwin
    import Foundation
    import Oliphaunt
    import OliphauntBrokerProtocol
    import OliphauntIOSBroker

    enum NativeBrokerFixture {
        private static let startupConfigurationDigest =
            "ios-native-broker-spike-v2-restricted-role"
        private static let selectedExtensions = ["pg_trgm", "vector"]
        private static let restrictedDatabaseRole = "oliphaunt_broker"

        static func run() async throws -> BrokerProbeResult {
            let hostPID = getpid()
            let manager = IOSBrokerManager()
            let brokerConfiguration = IOSBrokerConfiguration(
                expectedABI: 6,
                expectedRuntimeVersion: nil,
                startupConfigurationDigest: startupConfigurationDigest,
                maximumRequestBytes: OliphauntBrokerProtocol.defaultMaximumRequestBytes,
                requestDeadline: .seconds(15),
                extensionBundleIdentifier: BrokerFixtureBundleIdentifiers.extensionBundleIdentifier,
                controlReplyTimeout: .seconds(20),
                cancellationGracePeriod: .seconds(2)
            )
            let databaseConfiguration = OliphauntConfiguration(
                mode: .nativeBroker,
                root: nil,
                durability: .safe,
                runtimeFootprint: .smallMobile,
                extensions: selectedExtensions
            )
            let engine = IOSBrokerEngine(
                configuration: brokerConfiguration,
                manager: manager
            )

            var checks = Set<String>()
            var observations: [String: String] = [:]
            var diagnostics: [BrokerDiagnosticEvidence] = []
            var recoveredEpochs: [String] = []

            let controlSession = try await manager.open(
                configuration: brokerConfiguration,
                databaseConfiguration: databaseConfiguration
            )
            let initialManagerDiagnostics = await manager.diagnostics()
            let initialWorkerDiagnostics = try await controlSession.workerDiagnostics()
            try require(initialManagerDiagnostics.state.epoch == initialWorkerDiagnostics.epoch) {
                "manager and worker disagree about the initial epoch"
            }
            try require(initialWorkerDiagnostics.extensionProcessIdentifier != hostPID) {
                "host and extension unexpectedly have the same PID"
            }
            try require(
                initialWorkerDiagnostics.currentPhysFootprintBytes ?? 0 > 0
                    && initialWorkerDiagnostics.currentResidentBytes ?? 0 > 0
                    && initialWorkerDiagnostics.extensionEntryPreOpenPhysFootprintBytes ?? 0 > 0
                    && initialWorkerDiagnostics.extensionEntryPreOpenResidentBytes ?? 0 > 0
                    && initialWorkerDiagnostics.openedIdlePhysFootprintBytes ?? 0 > 0
                    && initialWorkerDiagnostics.openedIdleResidentBytes ?? 0 > 0
            ) {
                "worker diagnostics did not provide extensionEntryPreOpen/openedIdle memory samples"
            }
            let initialEpoch = initialWorkerDiagnostics.epoch.description
            let initialWorkerPID = initialWorkerDiagnostics.extensionProcessIdentifier
            diagnostics.append(
                evidence(
                    phase: "openedIdle",
                    manager: initialManagerDiagnostics,
                    worker: initialWorkerDiagnostics
                )
            )
            checks.formUnion([
                "extensionDiscovery",
                "separatePID",
                "xpcSession",
                "fdTransfer",
                "workerDiagnostics",
                "openedIdleMemory",
            ])

            let database = try await OliphauntDatabase.open(
                configuration: databaseConfiguration,
                engine: engine
            )
            let capabilities = try await database.capabilities()
            try require(capabilities.processIsolated) { "broker did not report process isolation" }
            try require(capabilities.crashRestartable) { "broker did not report crash recovery" }
            try require(capabilities.sameRootLogicalReopen) {
                "broker did not report same-root logical reopen"
            }
            try require(!capabilities.rootSwitchable && !capabilities.multiRoot) {
                "broker overclaimed root capabilities"
            }
            try require(!capabilities.backupRestore && capabilities.connectionString == nil) {
                "broker overclaimed backup or server capabilities"
            }
            checks.insert("capabilities")

            let roleState = try await database.query(
                """
                SELECT
                    current_user AS current_role,
                    session_user AS session_role,
                    rolsuper::text AS is_superuser,
                    rolcreatedb::text AS can_create_database,
                    rolcreaterole::text AS can_create_role,
                    rolinherit::text AS inherits_roles,
                    rolcanlogin::text AS can_login,
                    rolreplication::text AS can_replicate,
                    rolbypassrls::text AS can_bypass_rls,
                    current_setting('is_superuser') AS is_superuser_setting,
                    pg_has_role(current_user, 'pg_checkpoint', 'MEMBER')::text
                        AS can_checkpoint,
                    pg_has_role(current_user, 'pg_database_owner', 'USAGE')::text
                        AS can_assume_database_owner,
                    (
                      SELECT string_agg(candidate.rolname, ',' ORDER BY candidate.rolname)
                      FROM pg_roles candidate
                      WHERE pg_has_role(current_user, candidate.oid, 'USAGE')
                    ) AS effective_roles
                FROM pg_roles
                WHERE rolname = current_user
                """
            )
            try require(
                try roleState.getText(row: 0, column: "current_role") == restrictedDatabaseRole
                    && roleState.getText(row: 0, column: "session_role") == restrictedDatabaseRole
                    && roleState.getText(row: 0, column: "is_superuser") == "false"
                    && roleState.getText(row: 0, column: "can_create_database") == "false"
                    && roleState.getText(row: 0, column: "can_create_role") == "false"
                    && roleState.getText(row: 0, column: "inherits_roles") == "true"
                    && roleState.getText(row: 0, column: "can_login") == "true"
                    && roleState.getText(row: 0, column: "can_replicate") == "false"
                    && roleState.getText(row: 0, column: "can_bypass_rls") == "false"
                    && roleState.getText(row: 0, column: "is_superuser_setting") == "off"
                    && roleState.getText(row: 0, column: "can_checkpoint") == "true"
                    && roleState.getText(row: 0, column: "can_assume_database_owner") == "false"
                    && roleState.getText(row: 0, column: "effective_roles")
                        == "oliphaunt_broker,pg_checkpoint"
            ) {
                "host SQL was not confined to the restricted broker database role"
            }

            let databaseOwner = try await database.query(
                """
                SELECT pg_get_userbyid(datdba) AS owner
                FROM pg_database
                WHERE datname = current_database()
                """
            )
            let extensionOwners = try await database.query(
                """
                SELECT string_agg(
                    extname || ':' || pg_get_userbyid(extowner),
                    ',' ORDER BY extname
                ) AS owners
                FROM pg_extension
                WHERE extname = ANY (ARRAY['pg_trgm', 'vector']::name[])
                """
            )
            let brokerSchemaOwner = try await database.query(
                """
                SELECT pg_get_userbyid(nspowner) AS owner
                FROM pg_namespace
                WHERE nspname = 'oliphaunt_broker'
                """
            )
            try require(
                try databaseOwner.getText(row: 0, column: "owner") == "postgres"
                    && extensionOwners.getText(row: 0, column: "owners")
                        == "pg_trgm:postgres,vector:postgres"
                    && brokerSchemaOwner.getText(row: 0, column: "owner") == restrictedDatabaseRole
            ) {
                "broker role unexpectedly owned the database, selected extensions, or wrong schema"
            }

            let dataDirectorySQLState = try await expectPathAccessDenied("dataDirectory") {
                _ = try await database.query("SHOW data_directory")
            }
            let parameterizedDataDirectorySQLState = try await expectPathAccessDenied(
                "parameterizedDataDirectory"
            ) {
                _ = try await database.query(
                    "SELECT current_setting($1)",
                    parameters: [.text("data_directory")]
                )
            }
            let serverFileSQLState = try await expectPathAccessDenied("serverFile") {
                _ = try await database.query("SELECT pg_read_file('PG_VERSION')")
            }
            let bootstrapEscalationSQLState = try await expectPathAccessDenied(
                "bootstrapEscalation"
            ) {
                _ = try await database.query("SET ROLE postgres")
            }
            let sessionAuthorizationEscalationSQLState = try await expectPathAccessDenied(
                "sessionAuthorizationEscalation"
            ) {
                _ = try await database.query("SET SESSION AUTHORIZATION postgres")
            }
            let databaseOwnerEscalationSQLState = try await expectPathAccessDenied(
                "databaseOwnerEscalation"
            ) {
                _ = try await database.query("SET ROLE pg_database_owner")
            }
            let relationPathSQLState = try await expectPathAccessDenied("relationPath") {
                _ = try await database.query(
                    "SELECT pg_relation_filepath('pg_catalog.pg_class'::regclass)"
                )
            }
            let tablespacePathSQLState = try await expectPathAccessDenied("tablespacePath") {
                _ = try await database.query(
                    "SELECT pg_tablespace_location(oid) FROM pg_tablespace LIMIT 1"
                )
            }
            let listDirectorySQLState = try await expectPathAccessDenied("listDirectory") {
                _ = try await database.query("SELECT pg_ls_dir('.')")
            }
            let statFileSQLState = try await expectPathAccessDenied("statFile") {
                _ = try await database.query("SELECT pg_stat_file('PG_VERSION')")
            }
            let callerPathProbe = "/private/oliphaunt-denied"
            let largeObjectImportSQLState = try await expectPathAccessDenied(
                "largeObjectImport",
                allowingEchoOf: callerPathProbe
            ) {
                _ = try await database.query("SELECT lo_import('/private/oliphaunt-denied')")
            }
            let externalCopySQLState = try await expectPathAccessDenied(
                "externalCopy",
                allowingEchoOf: callerPathProbe
            ) {
                _ = try await database.query(
                    "COPY (SELECT 1) TO '/private/oliphaunt-denied'"
                )
            }
            _ = try await database.query(
                "CREATE TEMP TABLE oliphaunt_private_copy_probe(value text)"
            )
            let externalCopyFromSQLState = try await expectPathAccessDenied(
                "externalCopyFrom",
                allowingEchoOf: callerPathProbe
            ) {
                _ = try await database.query(
                    "COPY oliphaunt_private_copy_probe FROM '/private/oliphaunt-denied'"
                )
            }
            let alterSystemSQLState = try await expectPathAccessDenied("alterSystem") {
                _ = try await database.query("ALTER SYSTEM SET application_name = 'denied'")
            }
            let createRoleSQLState = try await expectPathAccessDenied("createRole") {
                _ = try await database.query("CREATE ROLE oliphaunt_broker_escalation_probe")
            }
            let selfSuperuserEscalationSQLState = try await expectPathAccessDenied(
                "selfSuperuserEscalation"
            ) {
                _ = try await database.query("ALTER ROLE oliphaunt_broker SUPERUSER")
            }
            let grantFileRoleSQLState = try await expectPathAccessDenied("grantFileRole") {
                _ = try await database.query(
                    "GRANT pg_read_server_files TO oliphaunt_broker"
                )
            }
            let dropSelectedExtensionSQLState = try await expectPathAccessDenied(
                "dropSelectedExtension"
            ) {
                _ = try await database.query("DROP EXTENSION pg_trgm")
            }
            let createTablespaceSQLState = try await expectPathAccessDenied(
                "createTablespace",
                allowingEchoOf: callerPathProbe
            ) {
                _ = try await database.query(
                    "CREATE TABLESPACE oliphaunt_denied LOCATION '/private/oliphaunt-denied'"
                )
            }
            let createNativeFunctionSQLState = try await expectPathAccessDenied(
                "createNativeFunction",
                allowingEchoOf: callerPathProbe
            ) {
                _ = try await database.query(
                    """
                    CREATE FUNCTION oliphaunt_broker.oliphaunt_denied_native()
                    RETURNS integer
                    AS '/private/oliphaunt-denied', 'oliphaunt_denied'
                    LANGUAGE C
                    """
                )
            }
            let loadLibrarySQLState = try await expectPathAccessDenied(
                "loadLibrary",
                allowingEchoOf: callerPathProbe
            ) {
                _ = try await database.query("LOAD '/private/oliphaunt-denied'")
            }
            let nonDefaultTablespaces = try await database.query(
                """
                SELECT count(*)::text AS count
                FROM pg_tablespace
                WHERE spcname NOT IN ('pg_default', 'pg_global')
                """
            )
            try require(try nonDefaultTablespaces.getText(row: 0, column: "count") == "0") {
                "broker root contained an unsupported non-default tablespace"
            }
            let visibleSettings = try await database.query(
                "SELECT setting FROM pg_settings WHERE name = 'data_directory'"
            )
            try require(visibleSettings.rowCount == 0) {
                "pg_settings exposed data_directory to the host-visible broker role"
            }
            let restrictedFunctionPrivileges = try await database.query(
                """
                SELECT count(*)::text AS count
                FROM unnest(ARRAY[
                  'pg_catalog.pg_backup_start(text,boolean)',
                  'pg_catalog.pg_backup_stop(boolean)',
                  'pg_catalog.pg_current_logfile()',
                  'pg_catalog.pg_current_logfile(text)',
                  'pg_catalog.lo_import(text)',
                  'pg_catalog.lo_import(text,oid)',
                  'pg_catalog.lo_export(oid,text)',
                  'pg_catalog.pg_ls_logdir()',
                  'pg_catalog.pg_ls_waldir()',
                  'pg_catalog.pg_ls_archive_statusdir()',
                  'pg_catalog.pg_ls_summariesdir()',
                  'pg_catalog.pg_ls_tmpdir()',
                  'pg_catalog.pg_ls_tmpdir(oid)',
                  'pg_catalog.pg_read_file(text)',
                  'pg_catalog.pg_read_file(text,boolean)',
                  'pg_catalog.pg_read_file(text,bigint,bigint)',
                  'pg_catalog.pg_read_file(text,bigint,bigint,boolean)',
                  'pg_catalog.pg_read_binary_file(text)',
                  'pg_catalog.pg_read_binary_file(text,boolean)',
                  'pg_catalog.pg_read_binary_file(text,bigint,bigint)',
                  'pg_catalog.pg_read_binary_file(text,bigint,bigint,boolean)',
                  'pg_catalog.pg_stat_file(text)',
                  'pg_catalog.pg_stat_file(text,boolean)',
                  'pg_catalog.pg_ls_dir(text)',
                  'pg_catalog.pg_ls_dir(text,boolean,boolean)',
                  'pg_catalog.pg_show_all_file_settings()',
                  'pg_catalog.pg_hba_file_rules()',
                  'pg_catalog.pg_ident_file_mappings()',
                  'pg_catalog.pg_config()'
                ]::text[]) restricted(signature)
                WHERE has_function_privilege(current_user, signature, 'EXECUTE')
                """
            )
            let restrictedViewPrivileges = try await database.query(
                """
                SELECT count(*)::text AS count
                FROM unnest(ARRAY[
                  'pg_catalog.pg_file_settings',
                  'pg_catalog.pg_hba_file_rules',
                  'pg_catalog.pg_ident_file_mappings',
                  'pg_catalog.pg_config'
                ]::text[]) restricted(name)
                WHERE has_table_privilege(current_user, name, 'SELECT')
                """
            )
            let visibleSettingPathEvidence = try await database.query(
                """
                SELECT
                  count(*) FILTER (
                    WHERE sourcefile IS NOT NULL OR sourceline IS NOT NULL
                  )::text AS source_path_rows,
                  count(*) FILTER (
                    WHERE setting LIKE '%/private/var/mobile/%'
                       OR setting LIKE '%/var/mobile/%'
                       OR setting LIKE '%/Users/%'
                       OR lower(setting) LIKE '%application support%'
                       OR lower(setting) LIKE '%runtime-cache%'
                       OR lower(setting) LIKE '%pgdata%'
                  )::text AS private_path_rows
                FROM pg_settings
                """
            )
            try require(
                try restrictedFunctionPrivileges.getText(row: 0, column: "count") == "0"
                    && restrictedViewPrivileges.getText(row: 0, column: "count") == "0"
                    && visibleSettingPathEvidence.getText(row: 0, column: "source_path_rows") == "0"
                    && visibleSettingPathEvidence.getText(row: 0, column: "private_path_rows")
                        == "0"
            ) {
                "catalog privilege or GUC visibility exposed a private filesystem path"
            }
            _ = try await database.query("RESET ROLE")
            _ = try await database.query("RESET SESSION AUTHORIZATION")
            let afterReset = try await database.query(
                """
                SELECT
                    current_user AS current_role,
                    session_user AS session_role,
                    current_setting('is_superuser') AS is_superuser
                """
            )
            try require(
                try afterReset.getText(row: 0, column: "current_role") == restrictedDatabaseRole
                    && afterReset.getText(row: 0, column: "session_role") == restrictedDatabaseRole
                    && afterReset.getText(row: 0, column: "is_superuser") == "off"
            ) {
                "RESET ROLE or RESET SESSION AUTHORIZATION escaped the restricted broker role"
            }
            let afterResetDataDirectorySQLState = try await expectPathAccessDenied(
                "afterResetDataDirectory"
            ) {
                _ = try await database.query("SHOW data_directory")
            }
            _ = try await database.query("DISCARD ALL")
            let afterDiscard = try await database.query(
                """
                SELECT
                    current_user AS current_role,
                    session_user AS session_role,
                    current_setting('is_superuser') AS is_superuser,
                    current_schemas(false)::text AS schemas
                """
            )
            try require(
                try afterDiscard.getText(row: 0, column: "current_role") == restrictedDatabaseRole
                    && afterDiscard.getText(row: 0, column: "session_role")
                        == restrictedDatabaseRole
                    && afterDiscard.getText(row: 0, column: "is_superuser") == "off"
                    && afterDiscard.getText(row: 0, column: "schemas")
                        == "{oliphaunt_broker,public}"
            ) {
                "DISCARD ALL escaped the restricted role or its broker-owned schema"
            }
            let afterDiscardDataDirectorySQLState = try await expectPathAccessDenied(
                "afterDiscardDataDirectory"
            ) {
                _ = try await database.query("SHOW data_directory")
            }

            _ = try await database.query(
                """
                DROP TEXT SEARCH DICTIONARY IF EXISTS
                    oliphaunt_broker.private_path_error_probe;
                CREATE TEXT SEARCH DICTIONARY
                    oliphaunt_broker.private_path_error_probe (
                      TEMPLATE = pg_catalog.simple,
                      STOPWORDS = 'oliphaunt_missing_private_path_probe'
                    )
                """
            )
            let sanitizedBackendErrorSQLState = try await expectSanitizedPostgresError {
                _ = try await database.query(
                    """
                    SELECT ts_lexize(
                        'oliphaunt_broker.private_path_error_probe',
                        'probe'
                    )
                    """
                )
            }
            _ = try? await database.query(
                "DROP TEXT SEARCH DICTIONARY oliphaunt_broker.private_path_error_probe"
            )
            let afterSanitizedError = try await database.query(
                "SELECT 'alive'::text AS status"
            )
            try require(try afterSanitizedError.getText(row: 0, column: "status") == "alive") {
                "backend ErrorResponse sanitization did not preserve session liveness"
            }
            observations["restrictedDatabaseRole"] = restrictedDatabaseRole
            observations["databaseOwner"] =
                try databaseOwner.getText(row: 0, column: "owner") ?? ""
            observations["selectedExtensionOwners"] =
                try extensionOwners.getText(row: 0, column: "owners") ?? ""
            observations["brokerSchemaOwner"] =
                try brokerSchemaOwner.getText(row: 0, column: "owner") ?? ""
            observations["dataDirectorySQLState"] = dataDirectorySQLState
            observations["parameterizedDataDirectorySQLState"] =
                parameterizedDataDirectorySQLState
            observations["serverFileSQLState"] = serverFileSQLState
            observations["bootstrapEscalationSQLState"] = bootstrapEscalationSQLState
            observations["sessionAuthorizationEscalationSQLState"] =
                sessionAuthorizationEscalationSQLState
            observations["databaseOwnerEscalationSQLState"] = databaseOwnerEscalationSQLState
            observations["relationPathSQLState"] = relationPathSQLState
            observations["tablespacePathSQLState"] = tablespacePathSQLState
            observations["listDirectorySQLState"] = listDirectorySQLState
            observations["statFileSQLState"] = statFileSQLState
            observations["largeObjectImportSQLState"] = largeObjectImportSQLState
            observations["externalCopySQLState"] = externalCopySQLState
            observations["externalCopyFromSQLState"] = externalCopyFromSQLState
            observations["alterSystemSQLState"] = alterSystemSQLState
            observations["createRoleSQLState"] = createRoleSQLState
            observations["selfSuperuserEscalationSQLState"] = selfSuperuserEscalationSQLState
            observations["grantFileRoleSQLState"] = grantFileRoleSQLState
            observations["dropSelectedExtensionSQLState"] = dropSelectedExtensionSQLState
            observations["createTablespaceSQLState"] = createTablespaceSQLState
            observations["createNativeFunctionSQLState"] = createNativeFunctionSQLState
            observations["loadLibrarySQLState"] = loadLibrarySQLState
            observations["nonDefaultTablespaceCount"] =
                try nonDefaultTablespaces.getText(row: 0, column: "count") ?? ""
            observations["afterResetDataDirectorySQLState"] = afterResetDataDirectorySQLState
            observations["afterDiscardDataDirectorySQLState"] =
                afterDiscardDataDirectorySQLState
            observations["afterDiscardSearchPath"] =
                try afterDiscard.getText(row: 0, column: "schemas") ?? ""
            observations["sanitizedBackendErrorSQLState"] = sanitizedBackendErrorSQLState
            observations["pgSettingsDataDirectoryRows"] = String(visibleSettings.rowCount)
            observations["restrictedFunctionExecuteCount"] =
                try restrictedFunctionPrivileges.getText(row: 0, column: "count") ?? ""
            observations["restrictedViewSelectCount"] =
                try restrictedViewPrivileges.getText(row: 0, column: "count") ?? ""
            observations["pgSettingsSourcePathRows"] =
                try visibleSettingPathEvidence.getText(row: 0, column: "source_path_rows") ?? ""
            observations["visiblePrivatePathSettingRows"] =
                try visibleSettingPathEvidence.getText(row: 0, column: "private_path_rows") ?? ""
            checks.insert("pgdataPathConfidentiality")

            let currentLaunchMarker = UUID().uuidString.lowercased()
            _ = try await database.query(
                """
                CREATE TABLE IF NOT EXISTS broker_spike_launch_history(
                    marker text PRIMARY KEY
                )
                """
            )
            let priorLaunchHistory = try await database.query(
                """
                SELECT coalesce(string_agg(marker, ',' ORDER BY marker), '') AS markers
                FROM broker_spike_launch_history
                """
            )
            observations["priorLaunchMarkers"] =
                try priorLaunchHistory.getText(row: 0, column: "markers") ?? ""
            observations["currentLaunchMarker"] = currentLaunchMarker
            _ = try await database.query(
                "INSERT INTO broker_spike_launch_history(marker) VALUES ($1)",
                parameters: [.text(currentLaunchMarker)]
            )

            let select = try await database.query("SELECT 42::text AS value")
            try require(try select.getText(row: 0, column: "value") == "42") {
                "real SELECT returned the wrong value"
            }
            checks.insert("realSelect")

            _ = try await database.query(
                """
                CREATE TABLE IF NOT EXISTS broker_spike_events(
                    operation_id text PRIMARY KEY,
                    payload text NOT NULL
                );
                TRUNCATE broker_spike_events;
                """
            )
            let inserted = try await database.query(
                """
                INSERT INTO broker_spike_events(operation_id, payload)
                VALUES ($1, $2)
                RETURNING payload
                """,
                parameters: [.text("parameterized"), .text("bound-value")]
            )
            try require(try inserted.getText(row: 0, column: "payload") == "bound-value") {
                "parameterized write returned the wrong payload"
            }
            checks.formUnion(["ddl", "write", "parameterizedQuery"])

            var expectedSQLState: String?
            do {
                _ = try await database.query("SELECT * FROM broker_spike_missing_relation")
            } catch OliphauntError.postgres(let postgresError) {
                expectedSQLState = postgresError.sqlstate
            }
            try require(expectedSQLState == "42P01") {
                "missing-relation error did not preserve SQLSTATE 42P01"
            }
            let afterError = try await database.query("SELECT 'alive'::text AS status")
            try require(try afterError.getText(row: 0, column: "status") == "alive") {
                "session did not recover after PostgreSQL ErrorResponse"
            }
            checks.insert("postgresErrorRecovery")

            _ = try await database.query("CREATE EXTENSION IF NOT EXISTS vector")
            _ = try await database.query("CREATE EXTENSION IF NOT EXISTS pg_trgm")
            let vector = try await database.query(
                """
                SELECT round(
                    ('[1,2,3]'::vector <-> '[1,2,4]'::vector)::numeric,
                    2
                )::text AS distance
                """
            )
            try require(try vector.getText(row: 0, column: "distance") == "1.00") {
                "vector extension returned an unexpected distance"
            }
            let trigram = try await database.query(
                "SELECT (similarity('postgres', 'postgress') > 0.5)::text AS similar"
            )
            try require(try trigram.getText(row: 0, column: "similar") == "true") {
                "pg_trgm similarity function was not usable"
            }
            checks.formUnion(["vectorExtension", "pgTrgmExtension"])

            let largeParameter = String(repeating: "x", count: 300 * 1024)
            let largeRequest = try await database.query(
                "SELECT length($1::text)::text AS length",
                parameters: [.text(largeParameter)]
            )
            try require(
                try largeRequest.getText(row: 0, column: "length") == String(largeParameter.count)
            ) {
                "multi-frame request assembly changed the bound parameter"
            }
            checks.formUnion(["fragmentedFrame", "boundedRequestAssembly", "multiFrameRequest"])

            let streamCounter = BrokerStreamCounter()
            let streamingStarted = BrokerFixtureSignal()
            let streaming = Task {
                try await database.execProtocolStream(
                    try OliphauntProtocol.simpleQuery(
                        "SELECT repeat('s', 1024) FROM generate_series(1, 2048)"
                    )
                ) { chunk in
                    streamCounter.consume(chunk)
                    if streamingStarted.signal() {
                        Thread.sleep(forTimeInterval: 0.5)
                    }
                }
            }
            await streamingStarted.wait()
            let streamingWorker = try await controlSession.workerDiagnostics()
            try require(
                streamingWorker.activeRequestID != nil
                    && streamingWorker.nativeDispatchStarted
            ) {
                "streaming diagnostics did not observe active native dispatch"
            }
            diagnostics.append(
                evidence(
                    phase: "streaming",
                    manager: await manager.diagnostics(),
                    worker: streamingWorker
                )
            )
            try await streaming.value
            try require(streamCounter.byteCount > 2 * 1024 * 1024) {
                "streaming response did not deliver the expected byte volume"
            }
            observations["streamedBytes"] = String(streamCounter.byteCount)
            observations["streamedChunks"] = String(streamCounter.chunkCount)
            checks.insert("streamingResponse")

            let secondDatabase = try await OliphauntDatabase.open(
                configuration: databaseConfiguration,
                engine: engine
            )
            let simultaneous = await manager.diagnostics()
            try require(simultaneous.logicalHandleCount == 3) {
                "simultaneous logical opens were not reference counted"
            }
            diagnostics.append(
                evidence(
                    phase: "simultaneousHandles",
                    manager: simultaneous,
                    worker: try await controlSession.workerDiagnostics()
                )
            )
            checks.formUnion(["simultaneousHandles", "referenceCounting"])

            _ = try await database.query(
                """
                CREATE TABLE IF NOT EXISTS broker_spike_fifo_events(
                    position bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    caller text NOT NULL
                );
                TRUNCATE broker_spike_fifo_events RESTART IDENTITY;
                """
            )
            let activeCaller = Task {
                try await database.query(
                    """
                    INSERT INTO broker_spike_fifo_events(caller)
                    SELECT 'active'
                    FROM (SELECT pg_sleep(2)) AS delay
                    RETURNING position::text AS position, caller
                    """
                )
            }
            let fifoActiveWorker = try await waitForActiveNativeRequest(
                session: controlSession,
                timeout: .seconds(5)
            )
            let fifoActiveManager = await manager.diagnostics()
            let fifoActiveRequestID = try requireValue(
                fifoActiveWorker.activeRequestID,
                "FIFO active worker diagnostics omitted the request ID"
            )
            try require(
                fifoActiveManager.activeRequestID == fifoActiveRequestID
                    && fifoActiveManager.queuedOperationCount == 0
            ) {
                "FIFO active manager diagnostics did not show exactly one unqueued request"
            }
            diagnostics.append(
                evidence(
                    phase: "fifoActive",
                    manager: fifoActiveManager,
                    worker: fifoActiveWorker
                )
            )

            let queuedCaller = Task {
                try await secondDatabase.query(
                    """
                    INSERT INTO broker_spike_fifo_events(caller)
                    VALUES ('queued')
                    RETURNING position::text AS position, caller
                    """
                )
            }
            let fifoQueuedManager = try await waitForQueuedOperation(
                manager: manager,
                timeout: .seconds(5)
            )
            let fifoQueuedWorker = try await controlSession.workerDiagnostics()
            try require(
                fifoQueuedManager.activeRequestID == fifoActiveRequestID
                    && fifoQueuedManager.queuedOperationCount == 1
                    && fifoQueuedWorker.activeRequestID == fifoActiveRequestID
                    && fifoQueuedWorker.nativeDispatchStarted
            ) {
                "FIFO diagnostics did not preserve one active native request and one queued operation"
            }
            diagnostics.append(
                evidence(
                    phase: "fifoQueued",
                    manager: fifoQueuedManager,
                    worker: fifoQueuedWorker
                )
            )

            let (activeResult, queuedResult) = try await (
                activeCaller.value,
                queuedCaller.value
            )
            try require(
                try activeResult.getText(row: 0, column: "caller") == "active"
                    && activeResult.getText(row: 0, column: "position") == "1"
            ) {
                "FIFO active caller did not complete first"
            }
            try require(
                try queuedResult.getText(row: 0, column: "caller") == "queued"
                    && queuedResult.getText(row: 0, column: "position") == "2"
            ) {
                "FIFO queued caller did not complete second"
            }
            let fifoOrderResult = try await database.query(
                """
                SELECT string_agg(caller, ',' ORDER BY position) AS observed_order
                FROM broker_spike_fifo_events
                """
            )
            let fifoObservedOrder = try requireValue(
                fifoOrderResult.getText(row: 0, column: "observed_order"),
                "FIFO ordering query returned NULL"
            )
            try require(fifoObservedOrder == "active,queued") {
                "logical operations were not serialized in FIFO order: \(fifoObservedOrder)"
            }
            let fifoDrainedManager = await manager.diagnostics()
            try require(
                fifoDrainedManager.activeRequestID == nil
                    && fifoDrainedManager.queuedOperationCount == 0
            ) {
                "FIFO manager did not drain active and queued operations"
            }
            observations["fifoActiveRequestID"] = String(fifoActiveRequestID.rawValue)
            observations["fifoQueuedOperationCount"] = String(
                fifoQueuedManager.queuedOperationCount
            )
            observations["fifoObservedOrder"] = fifoObservedOrder
            diagnostics.append(
                evidence(
                    phase: "fifoDrained",
                    manager: fifoDrainedManager,
                    worker: try await controlSession.workerDiagnostics()
                )
            )
            checks.insert("fifoSerialization")

            let transactionStarted = BrokerFixtureLatch()
            let rollingBack = Task {
                do {
                    try await database.transaction { transaction -> Void in
                        _ = try await transaction.query(
                            """
                            INSERT INTO broker_spike_events(operation_id, payload)
                            VALUES ('rolled-back-owner', 'must-not-persist')
                            """
                        )
                        await transactionStarted.signal()
                        try await Task.sleep(for: .milliseconds(250))
                        throw PlannedFixtureRollback()
                    }
                    throw BrokerFixtureFailure.assertion(
                        "planned transaction unexpectedly committed")
                } catch is PlannedFixtureRollback {
                    return
                }
            }
            await transactionStarted.wait()
            let independentWrite = Task {
                _ = try await secondDatabase.query(
                    """
                    INSERT INTO broker_spike_events(operation_id, payload)
                    VALUES ('independent-handle', 'must-persist')
                    """
                )
            }
            try await rollingBack.value
            try await independentWrite.value
            let transactionCounts = try await secondDatabase.query(
                """
                SELECT
                    count(*) FILTER (WHERE operation_id = 'rolled-back-owner')::text AS rolled_back,
                    count(*) FILTER (WHERE operation_id = 'independent-handle')::text AS independent
                FROM broker_spike_events
                """
            )
            try require(
                try transactionCounts.getText(row: 0, column: "rolled_back") == "0"
                    && transactionCounts.getText(row: 0, column: "independent") == "1"
            ) {
                "logical handles interleaved across a physical transaction"
            }
            checks.insert("transactionHandlePinning")

            let sleepingQuery = Task {
                try await secondDatabase.query("SELECT pg_sleep(10)")
            }
            try await Task.sleep(for: .milliseconds(150))
            let executingWorker = try await controlSession.workerDiagnostics()
            try require(
                executingWorker.activeRequestID != nil
                    && executingWorker.nativeDispatchStarted
            ) {
                "executing diagnostics did not observe active native dispatch"
            }
            diagnostics.append(
                evidence(
                    phase: "executing",
                    manager: await manager.diagnostics(),
                    worker: executingWorker
                )
            )
            try await secondDatabase.cancel()
            var cancellationSQLState: String?
            do {
                _ = try await sleepingQuery.value
            } catch OliphauntError.postgres(let postgresError) {
                cancellationSQLState = postgresError.sqlstate
            }
            try require(cancellationSQLState == "57014") {
                "cancellation did not produce PostgreSQL SQLSTATE 57014"
            }
            let afterCancel = try await secondDatabase.query("SELECT 'live'::text AS status")
            try require(try afterCancel.getText(row: 0, column: "status") == "live") {
                "worker was not live after cancellation"
            }
            checks.formUnion(["cancellation", "postCancelLiveness"])

            try await controlSession.checkpoint()
            diagnostics.append(
                evidence(
                    phase: "afterCheckpoint",
                    manager: await manager.diagnostics(),
                    worker: try await controlSession.workerDiagnostics()
                )
            )
            let prepared = try await controlSession.prepareForBackground(timeout: .seconds(5))
            try require(prepared.checkpointed) {
                "idle background preparation did not checkpoint"
            }
            try await controlSession.resumeFromBackground()
            let resumed = try await rawQuery(controlSession, "SELECT 'resumed'::text AS status")
            try require(try resumed.getText(row: 0, column: "status") == "resumed") {
                "background resume health check did not preserve liveness"
            }
            checks.formUnion(["checkpointControl", "backgroundLifecycle"])

            try await database.close()
            let afterFirstClose = try await secondDatabase.query(
                "SELECT count(*)::text AS count FROM broker_spike_events"
            )
            try require(try afterFirstClose.getText(row: 0, column: "count") != nil) {
                "closing one logical handle detached the shared physical session"
            }
            try await secondDatabase.close()
            try await controlSession.close()
            let detached = await manager.diagnostics()
            try require(detached.logicalHandleCount == 0 && detached.state == .idle) {
                "last logical close did not detach the manager"
            }
            diagnostics.append(evidence(phase: "logicalDetach", manager: detached, worker: nil))

            let reopenedControl = try await manager.open(
                configuration: brokerConfiguration,
                databaseConfiguration: databaseConfiguration
            )
            let reopenedWorker = try await reopenedControl.workerDiagnostics()
            try require(reopenedWorker.epoch.description != initialEpoch) {
                "same-root reopen reused a stale worker epoch"
            }
            recoveredEpochs.append(reopenedWorker.epoch.description)
            let reopenedDatabase = try await OliphauntDatabase.open(
                configuration: databaseConfiguration,
                engine: engine
            )
            let persisted = try await reopenedDatabase.query(
                """
                SELECT count(*)::text AS count
                FROM broker_spike_events
                WHERE operation_id = 'parameterized'
                """
            )
            try require(try persisted.getText(row: 0, column: "count") == "1") {
                "same-root reopen lost committed data"
            }
            diagnostics.append(
                evidence(
                    phase: "sameRootReopen",
                    manager: await manager.diagnostics(),
                    worker: reopenedWorker
                )
            )
            checks.insert("sameRootReopen")

            #if DEBUG
                let postCommitEpoch = reopenedWorker.epoch
                try await reopenedControl.injectFault(.afterNativeSuccessBeforeCompleted)
                try await expectOutcomeUnknown {
                    _ = try await reopenedControl.execProtocolRaw(
                        try OliphauntProtocol.simpleQuery(
                            """
                            BEGIN;
                            INSERT INTO broker_spike_events(operation_id, payload)
                            VALUES ('post-commit-ambiguity', 'committed-once');
                            COMMIT;
                            """
                        )
                    )
                }
                let postCommitCount = try await rawQuery(
                    reopenedControl,
                    """
                    SELECT count(*)::text AS count
                    FROM broker_spike_events
                    WHERE operation_id = 'post-commit-ambiguity'
                    """
                )
                try require(try postCommitCount.getText(row: 0, column: "count") == "1") {
                    "commit-ambiguity marker was absent or replayed"
                }
                let afterPostCommitRecovery = try await reopenedControl.workerDiagnostics()
                try require(afterPostCommitRecovery.epoch != postCommitEpoch) {
                    "post-commit crash did not establish a new epoch"
                }
                recoveredEpochs.append(afterPostCommitRecovery.epoch.description)
                diagnostics.append(
                    evidence(
                        phase: "postCommitRecovery",
                        manager: await manager.diagnostics(),
                        worker: afterPostCommitRecovery
                    )
                )
                checks.formUnion(["outcomeUnknown", "postCommitAmbiguity", "crashRecovery"])

                let preCommitEpoch = afterPostCommitRecovery.epoch
                try await reopenedControl.injectFault(.duringNativeExecution)
                try await expectOutcomeUnknown {
                    _ = try await reopenedControl.execProtocolRaw(
                        try OliphauntProtocol.simpleQuery(
                            """
                            BEGIN;
                            INSERT INTO broker_spike_events(operation_id, payload)
                            VALUES ('pre-commit-crash', 'must-roll-back');
                            SELECT pg_sleep(5);
                            COMMIT;
                            """
                        )
                    )
                }
                let preCommitCount = try await rawQuery(
                    reopenedControl,
                    """
                    SELECT count(*)::text AS count
                    FROM broker_spike_events
                    WHERE operation_id = 'pre-commit-crash'
                    """
                )
                try require(try preCommitCount.getText(row: 0, column: "count") == "0") {
                    "uncommitted marker survived worker crash and WAL recovery"
                }
                let afterPreCommitRecovery = try await reopenedControl.workerDiagnostics()
                try require(afterPreCommitRecovery.epoch != preCommitEpoch) {
                    "pre-commit crash did not establish a new epoch"
                }
                recoveredEpochs.append(afterPreCommitRecovery.epoch.description)
                diagnostics.append(
                    evidence(
                        phase: "preCommitRecovery",
                        manager: await manager.diagnostics(),
                        worker: afterPreCommitRecovery
                    )
                )
                checks.formUnion(["preCommitRollbackRecovery", "noAutomaticReplay"])
            #else
                observations["faultInjection"] = "not compiled in this configuration"
            #endif

            let finalDiagnostics = await manager.diagnostics()
            observations["launchCount"] = String(finalDiagnostics.launchCount)
            observations["interruptionCount"] = String(finalDiagnostics.interruptionCount)
            observations["initialWorkerPID"] = String(initialWorkerPID)

            if ProcessInfo.processInfo.environment["OLIPHAUNT_BROKER_DEVICE_LAUNCH_INDEX"] == "2" {
                _ = try await reopenedDatabase.query("DELETE FROM broker_spike_launch_history")
            } else {
                _ = try await reopenedDatabase.query(
                    "DELETE FROM broker_spike_launch_history WHERE marker <> $1",
                    parameters: [.text(currentLaunchMarker)]
                )
            }

            try await reopenedDatabase.close()
            try await reopenedControl.close()

            return BrokerProbeResult(
                hostPID: hostPID,
                workerPID: initialWorkerPID,
                epoch: initialEpoch,
                checks: checks.sorted(),
                recoveredEpochs: recoveredEpochs,
                diagnostics: diagnostics,
                observations: observations
            )
        }

        private static func rawQuery(
            _ session: IOSBrokerSession,
            _ sql: String
        ) async throws -> OliphauntQueryResult {
            try await parseOliphauntQueryResponse(
                session.execProtocolRaw(try OliphauntProtocol.simpleQuery(sql))
            )
        }

        private static func expectPathAccessDenied(
            _ label: String,
            allowingEchoOf callerSuppliedPath: String? = nil,
            _ operation: () async throws -> Void
        ) async throws -> String {
            do {
                try await operation()
            } catch OliphauntError.postgres(let postgresError) {
                try require(postgresError.sqlstate == "42501") {
                    "path-sensitive SQL returned SQLSTATE \(postgresError.sqlstate ?? "none")"
                }
                var visibleError = ([postgresError.description] + postgresError.fields.map(\.value))
                    .joined(separator: " ")
                if let callerSuppliedPath {
                    visibleError = visibleError.replacingOccurrences(
                        of: callerSuppliedPath,
                        with: "<caller-supplied-path>"
                    )
                }
                try require(
                    !visibleError.contains("/")
                        && !visibleError.lowercased().contains("pgdata")
                        && !visibleError.lowercased().contains("application support")
                ) {
                    "path-sensitive PostgreSQL denial exposed a private filesystem path"
                }
                return postgresError.sqlstate ?? ""
            }
            throw BrokerFixtureFailure.assertion(
                "path-sensitive SQL unexpectedly reached the host-visible broker session: \(label)"
            )
        }

        private static func expectSanitizedPostgresError(
            _ operation: () async throws -> Void
        ) async throws -> String {
            do {
                try await operation()
            } catch OliphauntError.postgres(let postgresError) {
                try require(postgresError.sqlstate?.isEmpty == false) {
                    "sanitized backend ErrorResponse lost its SQLSTATE"
                }
                let visibleError = ([postgresError.description] + postgresError.fields.map(\.value))
                    .joined(separator: " ")
                try require(
                    !visibleError.contains("/")
                        && !visibleError.lowercased().contains("pgdata")
                        && !visibleError.lowercased().contains("application support")
                        && !visibleError.lowercased().contains(
                            "oliphaunt_missing_private_path_probe.stop")
                ) {
                    "sanitized PostgreSQL ErrorResponse exposed a private filesystem path"
                }
                return postgresError.sqlstate ?? ""
            }
            throw BrokerFixtureFailure.assertion(
                "path-producing PostgreSQL query unexpectedly completed without an error"
            )
        }

        private static func waitForActiveNativeRequest(
            session: IOSBrokerSession,
            timeout: Duration
        ) async throws -> IOSBrokerWorkerDiagnostics {
            let clock = ContinuousClock()
            let deadline = clock.now.advanced(by: timeout)
            var lastError: (any Error)?
            while clock.now < deadline {
                do {
                    let diagnostics = try await session.workerDiagnostics()
                    if diagnostics.activeRequestID != nil && diagnostics.nativeDispatchStarted {
                        return diagnostics
                    }
                } catch {
                    lastError = error
                }
                try await Task.sleep(for: .milliseconds(20))
            }
            if let lastError { throw lastError }
            throw BrokerFixtureFailure.assertion(
                "worker diagnostics did not observe active native dispatch"
            )
        }

        private static func waitForQueuedOperation(
            manager: IOSBrokerManager,
            timeout: Duration
        ) async throws -> IOSBrokerDiagnostics {
            let clock = ContinuousClock()
            let deadline = clock.now.advanced(by: timeout)
            while clock.now < deadline {
                let diagnostics = await manager.diagnostics()
                if diagnostics.queuedOperationCount > 0 {
                    return diagnostics
                }
                try await Task.sleep(for: .milliseconds(20))
            }
            throw BrokerFixtureFailure.assertion(
                "manager diagnostics did not observe a queued operation"
            )
        }

        private static func requireValue<Value>(
            _ value: Value?,
            _ message: String
        ) throws -> Value {
            guard let value else {
                throw BrokerFixtureFailure.assertion(message)
            }
            return value
        }

        #if DEBUG
            private static func expectOutcomeUnknown(
                _ operation: () async throws -> Void
            ) async throws {
                do {
                    try await operation()
                } catch let error as BrokerError {
                    guard case .outcomeUnknown = error else { throw error }
                    return
                }
                throw BrokerFixtureFailure.assertion(
                    "faulted operation completed without OutcomeUnknown"
                )
            }
        #endif

        private static func evidence(
            phase: String,
            manager: IOSBrokerDiagnostics,
            worker: IOSBrokerWorkerDiagnostics?
        ) -> BrokerDiagnosticEvidence {
            BrokerDiagnosticEvidence(
                phase: phase,
                managerState: managerState(manager.state),
                epoch: manager.epoch?.description,
                workerPID: manager.extensionProcessIdentifier,
                logicalHandleCount: manager.logicalHandleCount,
                queuedOperationCount: manager.queuedOperationCount,
                activeRequestID: manager.activeRequestID?.rawValue,
                launchCount: manager.launchCount,
                interruptionCount: manager.interruptionCount,
                admissionsPaused: manager.admissionsPaused,
                workerState: worker?.state,
                transactionStatus: worker?.transactionStatus,
                manifestDigest: worker?.manifestDigest,
                currentPhysFootprintBytes: worker?.currentPhysFootprintBytes,
                currentResidentBytes: worker?.currentResidentBytes,
                availableMemoryBytes: worker?.availableMemoryBytes,
                nativeDispatchStarted: worker?.nativeDispatchStarted ?? false,
                checkpointInProgress: worker?.checkpointInProgress ?? false,
                storageProtectionEvidenceJSON: worker?.storageProtectionEvidenceJSON,
                extensionEntryPreOpenPhysFootprintBytes:
                    worker?.extensionEntryPreOpenPhysFootprintBytes,
                extensionEntryPreOpenResidentBytes: worker?.extensionEntryPreOpenResidentBytes,
                openedIdlePhysFootprintBytes: worker?.openedIdlePhysFootprintBytes,
                openedIdleResidentBytes: worker?.openedIdleResidentBytes
            )
        }

        private static func managerState(_ state: IOSBrokerManagerState) -> String {
            switch state {
            case .unavailable: "unavailable"
            case .idle: "idle"
            case .launching: "launching"
            case .binding: "binding"
            case .recovering: "recovering"
            case .ready: "ready"
            case .quiescing: "quiescing"
            case .interrupted: "interrupted"
            case .closing: "closing"
            }
        }

        private static func require(
            _ condition: @autoclosure () throws -> Bool,
            _ message: () -> String
        ) throws {
            guard try condition() else {
                throw BrokerFixtureFailure.assertion(message())
            }
        }
    }

    private struct PlannedFixtureRollback: Error {}

    private enum BrokerFixtureFailure: Error, CustomStringConvertible {
        case assertion(String)

        var description: String {
            switch self {
            case .assertion(let message): "broker fixture assertion failed: \(message)"
            }
        }
    }

    private actor BrokerFixtureLatch {
        private var signaled = false
        private var waiters: [CheckedContinuation<Void, Never>] = []

        func wait() async {
            if signaled { return }
            await withCheckedContinuation { continuation in
                waiters.append(continuation)
            }
        }

        func signal() {
            signaled = true
            let pending = waiters
            waiters.removeAll()
            for waiter in pending {
                waiter.resume()
            }
        }
    }

    private final class BrokerFixtureSignal: @unchecked Sendable {
        private let lock = NSLock()
        private var signaled = false
        private var waiters: [CheckedContinuation<Void, Never>] = []

        func wait() async {
            await withCheckedContinuation { continuation in
                lock.lock()
                if signaled {
                    lock.unlock()
                    continuation.resume()
                } else {
                    waiters.append(continuation)
                    lock.unlock()
                }
            }
        }

        @discardableResult
        func signal() -> Bool {
            lock.lock()
            guard !signaled else {
                lock.unlock()
                return false
            }
            signaled = true
            let pending = waiters
            waiters.removeAll()
            lock.unlock()
            for waiter in pending {
                waiter.resume()
            }
            return true
        }
    }

    private final class BrokerStreamCounter: @unchecked Sendable {
        private let lock = NSLock()
        private var bytes = 0
        private var chunks = 0

        func consume(_ chunk: Data) {
            lock.lock()
            bytes += chunk.count
            chunks += 1
            lock.unlock()
        }

        var byteCount: Int {
            lock.lock()
            defer { lock.unlock() }
            return bytes
        }

        var chunkCount: Int {
            lock.lock()
            defer { lock.unlock() }
            return chunks
        }
    }
#endif

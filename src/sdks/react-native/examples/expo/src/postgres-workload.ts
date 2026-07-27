import {
  PostgresError,
  simpleQuery,
  type MobileReleaseExtensionProof,
  type OliphauntDatabase,
  type QueryResult,
} from '@oliphaunt/react-native';

export type ProjectRollup = {
  name: string;
  total: string;
  done: string;
  blocked: string;
  estimate: string;
};

export type ActivityItem = {
  title: string;
  owner: string;
  status: string;
};

export type OperationCheck = {
  name: string;
  detail: string;
  elapsedMs: number;
};

export type PerfReport = {
  openMs: number;
  schemaMs: number;
  seedMs: number;
  updateMs: number;
  selectP50Ms: number;
  selectP90Ms: number;
  selectP99Ms: number;
  rows: string;
  doneRows: string;
  blockedRows: string;
  checksum: string;
  events: string;
  checks: string;
  backupBytes: string;
  streamBytes: string;
  rawBytes: string;
  cancelSqlstate: string;
  constraintSqlstate: string;
};

export type PostgresGamutReport = {
  perf: PerfReport;
  projects: ProjectRollup[];
  activity: ActivityItem[];
  checks: OperationCheck[];
};

export type WorkloadCheckStage = {
  name: string;
  status: 'start' | 'done';
  detail?: string;
  elapsedMs?: number;
};

export type PostgresGamutOptions = {
  extensions?: readonly string[];
  onCheckStage?: (stage: WorkloadCheckStage) => void;
};

export async function runMobileReleaseExtensionProof(
  db: OliphauntDatabase,
  plan: readonly MobileReleaseExtensionProof[],
  onCheckStage?: (stage: WorkloadCheckStage) => void,
): Promise<OperationCheck[]> {
  const checks: OperationCheck[] = [];
  for (const extension of plan) {
    await record(
      checks,
      `extension activation: ${extension.sqlName}`,
      async () => {
        for (const statement of extension.activationSql) {
          await db.execute(statement);
        }
        if (extension.createsExtension) {
          const result = await db.query(
            `SELECT extname::text AS name, extversion::text AS version
             FROM pg_extension
             WHERE extname = $1`,
            [extension.sqlName],
          );
          assertEqual(requiredText(result, 0, 'name'), extension.sqlName, `${extension.sqlName} catalog identity`);
          const version = requiredText(result, 0, 'version');
          if (version.trim().length === 0) {
            throw new Error(`${extension.sqlName} catalog version is empty`);
          }
          return `${extension.sqlName} ${version}; dependency closure ${extension.selectedExtensionDependencies.join(',') || 'none'}`;
        }

        const configured = await scalar(
          db,
          "SELECT current_setting('auto_explain.log_min_duration')::text AS value",
        );
        assertEqual(configured, '0', 'auto_explain load/configuration proof');
        return 'auto_explain loaded and configured in the installed app session';
      },
      onCheckStage,
    );
  }

  await record(
    checks,
    'extension activation catalog completeness',
    async () => {
      const expected = plan
        .filter((extension) => extension.createsExtension)
        .map((extension) => extension.sqlName)
        .sort()
        .join(',');
      const actual = await scalar(
        db,
        `SELECT coalesce(string_agg(extname, ',' ORDER BY extname), '')::text AS value
         FROM pg_extension
         WHERE extname <> 'plpgsql'`,
      );
      assertEqual(actual, expected, 'installed mobile extension catalog');
      return `${plan.length} release extensions activated; ${expected.split(',').length} CREATE EXTENSION catalog rows plus auto_explain`;
    },
    onCheckStage,
  );
  return checks;
}

type MutablePerf = {
  schemaMs: number;
  seedMs: number;
  updateMs: number;
  selectP50Ms: number;
  selectP90Ms: number;
  selectP99Ms: number;
  rows: string;
  doneRows: string;
  blockedRows: string;
  checksum: string;
  events: string;
  backupBytes: string;
  streamBytes: string;
  rawBytes: string;
  cancelSqlstate: string;
  constraintSqlstate: string;
};

export async function runPostgresGamutWorkload(
  db: OliphauntDatabase,
  openMs: number,
  options: PostgresGamutOptions = {},
): Promise<PostgresGamutReport> {
  const checks: OperationCheck[] = [];
  const extensions = new Set(options.extensions ?? []);
  const perf: MutablePerf = {
    schemaMs: 0,
    seedMs: 0,
    updateMs: 0,
    selectP50Ms: 0,
    selectP90Ms: 0,
    selectP99Ms: 0,
    rows: '0',
    doneRows: '0',
    blockedRows: '0',
    checksum: '0',
    events: '0',
    backupBytes: '0',
    streamBytes: '0',
    rawBytes: '0',
    cancelSqlstate: '',
    constraintSqlstate: '',
  };
  const recordCheck = (
    name: string,
    run: () => Promise<string>,
  ) => record(checks, name, run, options.onCheckStage);

  await recordCheck('DDL, enum, indexes, audit rule, view', async () => {
    const started = now();
    await resetSchema(db);
    const ruleCount = await scalar(
      db,
      "SELECT count(*)::text AS value FROM pg_rules WHERE schemaname = 'public' AND tablename = 'tasks' AND rulename = 'tasks_audit_rule'",
    );
    assertEqual(ruleCount, '1', 'tasks audit rule registration');
    perf.schemaMs = now() - started;
    return 'projects, tasks, dependencies, events, metrics, JSONB/array GIN indexes';
  });

  await recordCheck('DDL event trigger', async () => {
    await executeStatements(db, [
      `CREATE TABLE ddl_event_audit (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        command_tag text NOT NULL,
        event_name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE FUNCTION oliphaunt_mobile_ddl_audit() RETURNS event_trigger
       LANGUAGE plpgsql
       AS $$
       BEGIN
         INSERT INTO ddl_event_audit(command_tag, event_name)
         VALUES (TG_TAG, TG_EVENT);
       END
       $$`,
      `CREATE EVENT TRIGGER oliphaunt_mobile_ddl_audit
       ON ddl_command_end
       EXECUTE FUNCTION oliphaunt_mobile_ddl_audit()`,
      'CREATE TABLE ddl_event_probe (id integer PRIMARY KEY)',
      'ALTER TABLE ddl_event_probe ADD COLUMN label text',
      'DROP TABLE ddl_event_probe',
    ]);

    const result = await db.query(`
      SELECT
        count(*) FILTER (WHERE command_tag = 'CREATE TABLE')::text AS creates,
        count(*) FILTER (WHERE command_tag = 'ALTER TABLE')::text AS alters,
        count(*) FILTER (WHERE command_tag = 'DROP TABLE')::text AS drops,
        string_agg(command_tag, ', ' ORDER BY id)::text AS tags
      FROM ddl_event_audit
    `);
    const creates = requiredText(result, 0, 'creates');
    const alters = requiredText(result, 0, 'alters');
    const drops = requiredText(result, 0, 'drops');
    assertPositiveInteger(creates, 'DDL event trigger CREATE TABLE count');
    assertPositiveInteger(alters, 'DDL event trigger ALTER TABLE count');
    assertPositiveInteger(drops, 'DDL event trigger DROP TABLE count');

    await executeStatements(db, [
      'DROP EVENT TRIGGER oliphaunt_mobile_ddl_audit',
      'DROP FUNCTION oliphaunt_mobile_ddl_audit()',
    ]);

    return requiredText(result, 0, 'tags');
  });

  if (extensions.has('vector')) {
    await recordCheck('pgvector extension nearest-neighbor search', async () => {
      const result = await runPgvectorWorkload(db);
      return `${result.nearestTitle} nearest to ${result.query}, distance ${result.distance}, index ${result.indexName}`;
    });
  }

  if (!extensions.has('vector')) {
    await recordCheck('extension selection', async () => {
      const active = [...extensions].sort().join(', ') || 'none';
      return `active extensions: ${active}; pgvector workload runs only when vector is packaged`;
    });
  }

  await recordCheck('transaction seed with savepoint recovery', async () => {
    const started = now();
    const inserted = await seedDatabase(db);
    perf.seedMs = now() - started;
    return `${inserted.projects} projects, ${inserted.tasks} tasks, ${inserted.dependencies} dependencies`;
  });

  await recordCheck('explicit rollback keeps data unchanged', async () => {
    const before = await scalar(db, 'SELECT count(*)::text AS value FROM projects');
    await expectMessage(async () => {
      await db.transaction(async tx => {
        await tx.query(
          `INSERT INTO projects (id, name, owner, health, metadata, tags, budget)
           VALUES (9999, 'Rollback Probe', 'Nia', 'green', '{}'::jsonb, ARRAY['probe'], 1)`,
        );
        throw new Error('intentional rollback probe');
      });
    }, 'intentional rollback probe');
    const after = await scalar(db, 'SELECT count(*)::text AS value FROM projects');
    assertEqual(after, before, 'rollback project count');
    return `project count stayed ${after}`;
  });

  await recordCheck('constraints and PostgreSQL error recovery', async () => {
    const sqlstate = await expectPostgresError(async () => {
      await db.query(
        `INSERT INTO tasks
           (id, project_id, title, owner, status, priority, estimate, metadata, labels)
         VALUES
           (9999, 99999, 'missing project', 'Nia', 'open', 1, 1, '{}'::jsonb, ARRAY['probe'])`,
      );
    }, '23503');
    const recovered = await scalar(db, "SELECT 'recovered'::text AS value");
    assertEqual(recovered, 'recovered', 'constraint recovery query');
    perf.constraintSqlstate = sqlstate;
    return `foreign-key violation ${sqlstate}, then recovered`;
  });

  await recordCheck('bulk update, audit rule, upsert metrics', async () => {
    const started = now();
    const update = await updateTasksAndMetrics(db);
    perf.updateMs = now() - started;
    const events = await scalar(db, 'SELECT count(*)::text AS value FROM task_events');
    const metricRows = await scalar(db, 'SELECT count(*)::text AS value FROM project_metrics');
    assertPositiveInteger(events, 'audit event count');
    return `${update.archivedRows} archived updates, ${update.finalRows} final updates, ${events} audit events, ${metricRows} metric rows`;
  });

  await recordCheck('JSONB and array predicates', async () => {
    const result = await db.query(`
      SELECT
        count(*)::text AS high_mobile,
        count(DISTINCT metadata->>'region')::text AS regions
      FROM tasks
      WHERE metadata @> '{"risk":"high"}'::jsonb
        AND labels @> ARRAY['mobile']::text[]
    `);
    const highMobile = requiredText(result, 0, 'high_mobile');
    const regions = requiredText(result, 0, 'regions');
    assertPositiveInteger(highMobile, 'high mobile JSONB/array count');
    return `${highMobile} high-risk mobile tasks across ${regions} regions`;
  });

  await recordCheck('CTE, recursive CTE, and window functions', async () => {
    const recursive = await scalar(
      db,
      `WITH RECURSIVE chain(n) AS (
         VALUES (1)
         UNION ALL
         SELECT n + 1 FROM chain WHERE n < 12
       )
       SELECT sum(n)::text AS value FROM chain`,
    );
    assertEqual(recursive, '78', 'recursive CTE sum');

    const ranked = await db.query(`
      WITH ranked AS (
        SELECT
          id,
          dense_rank() OVER (
            PARTITION BY project_id
            ORDER BY priority DESC, estimate DESC, id ASC
          ) AS rank
        FROM tasks
      )
      SELECT
        count(*) FILTER (WHERE rank = 1)::text AS top_tasks,
        max(rank)::text AS max_rank
      FROM ranked
    `);
    const topTasks = requiredText(ranked, 0, 'top_tasks');
    const maxRank = requiredText(ranked, 0, 'max_rank');
    assertPositiveInteger(topTasks, 'window top task count');
    assertPositiveInteger(maxRank, 'window max rank');
    return `recursive sum ${recursive}, ${topTasks} rank-1 tasks, max rank ${maxRank}`;
  });

  await recordCheck('temporary table and DELETE RETURNING', async () => {
    await db.execute(`
      CREATE TEMP TABLE temp_cleanup_queue (
        id integer PRIMARY KEY,
        label text NOT NULL
      ) ON COMMIT PRESERVE ROWS;
      INSERT INTO temp_cleanup_queue VALUES
        (1, 'one'),
        (2, 'two'),
        (3, 'three'),
        (4, 'four');
    `);
    const deleted = await db.query(`
      WITH deleted AS (
        DELETE FROM temp_cleanup_queue
        WHERE id <= $1
        RETURNING id
      )
      SELECT count(*)::text AS deleted, coalesce(max(id), 0)::text AS max_id
      FROM deleted
    `, [3]);
    assertEqual(requiredText(deleted, 0, 'deleted'), '3', 'delete returning count');
    assertEqual(requiredText(deleted, 0, 'max_id'), '3', 'delete returning max');
    return 'deleted 3 temp rows through RETURNING';
  });

  await recordCheck('extended query parameters and nulls', async () => {
    const result = await db.query(
      `SELECT
         ($1::int + $2::int)::text AS sum,
         $3::boolean::text AS flag,
         ($4::text IS NULL)::text AS is_null`,
      [19, 23, true, null],
    );
    assertEqual(requiredText(result, 0, 'sum'), '42', 'extended query sum');
    assertEqual(requiredText(result, 0, 'flag'), 'true', 'extended query bool');
    assertEqual(requiredText(result, 0, 'is_null'), 'true', 'extended query null');
    return 'int, boolean, and null parameters round-tripped';
  });

  await recordCheck('raw protocol and streaming response', async () => {
    const raw = await db.execProtocolRaw(simpleQuery('SELECT 1 AS raw_value; SELECT 2 AS raw_value'));
    let streamBytes = 0;
    let chunks = 0;
    await db.execProtocolStream(
      simpleQuery("SELECT repeat('x', 65536) AS payload"),
      chunk => {
        chunks += 1;
        streamBytes += chunk.byteLength;
      },
    );
    assertPositiveInteger(String(raw.byteLength), 'raw protocol byte length');
    assertPositiveInteger(String(streamBytes), 'streaming byte length');
    perf.rawBytes = String(raw.byteLength);
    perf.streamBytes = String(streamBytes);
    return `${raw.byteLength} raw bytes, ${streamBytes} streamed bytes in ${chunks} chunk(s)`;
  });

  await recordCheck('query cancellation and recovery', async () => {
    const running = db.query("SELECT pg_sleep(5), 'late'::text AS value");
    await sleep(120);
    await db.cancel();
    const sqlstate = await expectPostgresPromiseError(running, '57014');
    const recovered = await scalar(db, "SELECT 'after-cancel'::text AS value");
    assertEqual(recovered, 'after-cancel', 'cancel recovery query');
    perf.cancelSqlstate = sqlstate;
    return `cancelled with ${sqlstate}, then recovered`;
  });

  await recordCheck('checkpoint and physical backup', async () => {
    await db.checkpoint();
    const backup = await db.backup('physicalArchive');
    assertPositiveInteger(String(backup.bytes.byteLength), 'physical backup bytes');
    perf.backupBytes = String(backup.bytes.byteLength);
    return `${backup.bytes.byteLength} backup bytes`;
  });

  const selectStats = await measureRollupSelects(db);
  perf.selectP50Ms = selectStats.p50;
  perf.selectP90Ms = selectStats.p90;
  perf.selectP99Ms = selectStats.p99;
  perf.rows = selectStats.rows;
  perf.doneRows = selectStats.doneRows;
  perf.blockedRows = selectStats.blockedRows;
  perf.checksum = selectStats.checksum;
  perf.events = await scalar(db, 'SELECT count(*)::text AS value FROM task_events');

  const projects = await loadProjectRollup(db);
  const activity = await loadActivity(db);

  return {
    perf: {
      openMs,
      ...perf,
      checks: String(checks.length),
    },
    projects,
    activity,
    checks,
  };
}

export async function runPostgresLifecycleResumeCheck(
  db: OliphauntDatabase,
): Promise<OperationCheck> {
  const started = now();
  const select = await scalar(db, 'SELECT 1::text AS value');
  assertEqual(select, '1', 'resume SELECT 1');

  const eventsBefore = await scalar(db, 'SELECT count(*)::text AS value FROM task_events');
  const updated = await db.query(`
    UPDATE tasks
    SET status = CASE
          WHEN status = 'open'::task_status THEN 'blocked'::task_status
          ELSE 'open'::task_status
        END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
    RETURNING status::text AS status
  `);
  assertEqual(String(updated.rowCount), '1', 'resume audit-rule update row count');
  const eventsAfter = await scalar(db, 'SELECT count(*)::text AS value FROM task_events');
  assertGreaterThanBigInt(eventsAfter, eventsBefore, 'resume audit-rule event count');

  await executeStatements(db, [
    'DROP EVENT TRIGGER IF EXISTS oliphaunt_mobile_resume_ddl_audit',
    'DROP FUNCTION IF EXISTS oliphaunt_mobile_resume_ddl_audit()',
    'DROP TABLE IF EXISTS ddl_resume_audit CASCADE',
    `CREATE TABLE ddl_resume_audit (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      command_tag text NOT NULL,
      event_name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE FUNCTION oliphaunt_mobile_resume_ddl_audit() RETURNS event_trigger
     LANGUAGE plpgsql
     AS $$
     BEGIN
       INSERT INTO ddl_resume_audit(command_tag, event_name)
       VALUES (TG_TAG, TG_EVENT);
     END
     $$`,
    `CREATE EVENT TRIGGER oliphaunt_mobile_resume_ddl_audit
     ON ddl_command_end
     EXECUTE FUNCTION oliphaunt_mobile_resume_ddl_audit()`,
    'CREATE TABLE ddl_resume_probe (id integer PRIMARY KEY)',
    'ALTER TABLE ddl_resume_probe ADD COLUMN label text',
    'DROP TABLE ddl_resume_probe',
  ]);

  const ddl = await db.query(`
    SELECT
      count(*) FILTER (WHERE command_tag = 'CREATE TABLE')::text AS creates,
      count(*) FILTER (WHERE command_tag = 'ALTER TABLE')::text AS alters,
      count(*) FILTER (WHERE command_tag = 'DROP TABLE')::text AS drops,
      string_agg(command_tag, ', ' ORDER BY id)::text AS tags
    FROM ddl_resume_audit
  `);
  const creates = requiredText(ddl, 0, 'creates');
  const alters = requiredText(ddl, 0, 'alters');
  const drops = requiredText(ddl, 0, 'drops');
  assertPositiveInteger(creates, 'resume DDL trigger CREATE TABLE count');
  assertPositiveInteger(alters, 'resume DDL trigger ALTER TABLE count');
  assertPositiveInteger(drops, 'resume DDL trigger DROP TABLE count');

  await executeStatements(db, [
    'DROP EVENT TRIGGER oliphaunt_mobile_resume_ddl_audit',
    'DROP FUNCTION oliphaunt_mobile_resume_ddl_audit()',
    'DROP TABLE ddl_resume_audit',
  ]);

  return {
    name: 'background/foreground resume SQL',
    detail: `SELECT ${select}, audit events ${eventsBefore}->${eventsAfter}, DDL tags ${requiredText(ddl, 0, 'tags')}`,
    elapsedMs: now() - started,
  };
}

async function resetSchema(db: OliphauntDatabase): Promise<void> {
  await executeStatements(db, [
    'DROP EVENT TRIGGER IF EXISTS oliphaunt_mobile_ddl_audit',
    'DROP FUNCTION IF EXISTS oliphaunt_mobile_ddl_audit()',
    'DROP TABLE IF EXISTS ddl_event_audit CASCADE',
    'DROP TABLE IF EXISTS task_events, task_dependencies, project_metrics, tasks, projects CASCADE',
    'DROP TYPE IF EXISTS task_status',
    "CREATE TYPE task_status AS ENUM ('open', 'blocked', 'done', 'archived')",
    `CREATE TABLE projects (
      id integer PRIMARY KEY,
      name text NOT NULL UNIQUE,
      owner text NOT NULL,
      health text NOT NULL CHECK (health IN ('green', 'yellow', 'red')),
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      tags text[] NOT NULL DEFAULT ARRAY[]::text[],
      budget numeric(12,2) NOT NULL CHECK (budget >= 0),
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE tasks (
      id integer PRIMARY KEY,
      project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title text NOT NULL,
      owner text NOT NULL,
      status task_status NOT NULL DEFAULT 'open',
      priority integer NOT NULL CHECK (priority BETWEEN 1 AND 4),
      estimate integer NOT NULL CHECK (estimate > 0),
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      labels text[] NOT NULL DEFAULT ARRAY[]::text[],
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (project_id, title)
    )`,
    `CREATE TABLE task_dependencies (
      task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, depends_on_task_id),
      CHECK (task_id <> depends_on_task_id)
    )`,
    `CREATE TABLE task_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      event_type text NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE project_metrics (
      project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      metric text NOT NULL,
      value numeric NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (project_id, metric)
    )`,
    'CREATE INDEX tasks_project_status_idx ON tasks (project_id, status)',
    'CREATE INDEX tasks_updated_idx ON tasks (updated_at DESC, id DESC)',
    'CREATE INDEX tasks_metadata_gin_idx ON tasks USING gin (metadata)',
    'CREATE INDEX tasks_labels_gin_idx ON tasks USING gin (labels)',
    'CREATE INDEX tasks_lower_title_idx ON tasks ((lower(title)))',
    'CREATE INDEX task_events_payload_gin_idx ON task_events USING gin (payload)',
    `CREATE VIEW task_dashboard AS
      SELECT
        p.id,
        p.name,
        count(t.id) AS total,
        count(t.id) FILTER (WHERE t.status = 'done') AS done,
        count(t.id) FILTER (WHERE t.status = 'blocked') AS blocked,
        coalesce(sum(t.estimate), 0) AS estimate
      FROM projects p
      LEFT JOIN tasks t ON t.project_id = p.id
      GROUP BY p.id, p.name`,
    `CREATE RULE tasks_audit_rule AS
    ON UPDATE TO tasks
    WHERE OLD.status IS DISTINCT FROM NEW.status
    DO ALSO
      INSERT INTO task_events (task_id, event_type, payload)
      VALUES (
        NEW.id,
        'status_change',
        jsonb_build_object(
          'from', OLD.status::text,
          'to', NEW.status::text,
          'owner', NEW.owner,
          'priority', NEW.priority
        )
      )`,
  ]);
}

async function runPgvectorWorkload(
  db: OliphauntDatabase,
): Promise<{query: string; nearestTitle: string; distance: string; indexName: string}> {
  await executeStatements(db, [
    'CREATE EXTENSION IF NOT EXISTS vector',
    'DROP TABLE IF EXISTS mobile_embedding_docs',
    `CREATE TABLE mobile_embedding_docs (
      id integer PRIMARY KEY,
      title text NOT NULL,
      embedding vector(3) NOT NULL
    )`,
    `INSERT INTO mobile_embedding_docs (id, title, embedding) VALUES
      (1, 'field dispatch routing', '[0.95,0.05,0.10]'),
      (2, 'warehouse replenishment', '[0.05,0.92,0.18]'),
      (3, 'customer support triage', '[0.22,0.15,0.94]'),
      (4, 'mobile incident response', '[0.88,0.10,0.22]')`,
    `CREATE INDEX mobile_embedding_docs_hnsw_idx
      ON mobile_embedding_docs USING hnsw (embedding vector_l2_ops)`,
  ]);

  const query = '[1,0,0]';
  const nearest = await db.query(
    `SELECT
       title,
       round((embedding <-> $1::vector)::numeric, 4)::text AS distance
     FROM mobile_embedding_docs
     ORDER BY embedding <-> $1::vector
     LIMIT 1`,
    [query],
  );
  const nearestTitle = requiredText(nearest, 0, 'title');
  const distance = requiredText(nearest, 0, 'distance');
  assertEqual(nearestTitle, 'field dispatch routing', 'pgvector nearest row');

  const index = await db.query(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'mobile_embedding_docs'
      AND indexname = 'mobile_embedding_docs_hnsw_idx'
  `);
  const indexName = requiredText(index, 0, 'indexname');
  return {query, nearestTitle, distance, indexName};
}

async function seedDatabase(
  db: OliphauntDatabase,
): Promise<{projects: number; tasks: number; dependencies: number}> {
  let dependencies = 0;
  await db.transaction(async tx => {
    for (const project of projectSeeds) {
      await tx.query(
        `INSERT INTO projects (id, name, owner, health, metadata, tags, budget)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::text[], $7::numeric)`,
        [
          project.id,
          project.name,
          project.owner,
          project.health,
          JSON.stringify(project.metadata),
          postgresTextArray(project.tags),
          project.budget,
        ],
      );
    }

    await tx.execute('SAVEPOINT duplicate_project_name');
    const duplicateSqlstate = await expectPostgresError(async () => {
      await tx.query(
        `INSERT INTO projects (id, name, owner, health, metadata, tags, budget)
         VALUES (991, $1, 'Probe', 'green', '{}'::jsonb, ARRAY['probe'], 1)`,
        [projectSeeds[0]?.name ?? 'Dispatch'],
      );
    }, '23505');
    assertEqual(duplicateSqlstate, '23505', 'duplicate project savepoint');
    await tx.execute('ROLLBACK TO SAVEPOINT duplicate_project_name');
    await tx.execute('RELEASE SAVEPOINT duplicate_project_name');

    for (let index = 1; index <= TASK_COUNT; index += 1) {
      const project = projectSeeds[index % projectSeeds.length] ?? projectSeeds[0];
      const status = index % 13 === 0 ? 'blocked' : index % 7 === 0 ? 'done' : 'open';
      const owner = owners[index % owners.length] ?? 'Asha';
      const risk = index % 9 === 0 ? 'high' : index % 4 === 0 ? 'medium' : 'low';
      const labels = [
        index % 2 === 0 ? 'mobile' : 'desktop',
        index % 3 === 0 ? 'sync' : 'ui',
        index % 5 === 0 ? 'customer' : 'internal',
      ];
      const metadata = {
        risk,
        region: regions[index % regions.length],
        sprint: `2026.${(index % 6) + 1}`,
        external: index % 17 === 0,
      };
      await tx.query(
        `INSERT INTO tasks
           (id, project_id, title, owner, status, priority, estimate, metadata, labels)
         VALUES ($1, $2, $3, $4, $5::task_status, $6, $7, $8::jsonb, $9::text[])
         RETURNING id::text AS id`,
        [
          index,
          project.id,
          `${project.name} field operation ${index}`,
          owner,
          status,
          (index % 4) + 1,
          (index % 13) + 1,
          JSON.stringify(metadata),
          postgresTextArray(labels),
        ],
      );

      if (index > 8 && index % 8 === 0) {
        await tx.query(
          `INSERT INTO task_dependencies (task_id, depends_on_task_id)
           VALUES ($1, $2)`,
          [index, index - 3],
        );
        dependencies += 1;
      }
    }
  });
  return {projects: projectSeeds.length, tasks: TASK_COUNT, dependencies};
}

async function updateTasksAndMetrics(
  db: OliphauntDatabase,
): Promise<{archivedRows: number; finalRows: number}> {
  let archivedRows = 0;
  let finalRows = 0;
  await db.transaction(async tx => {
    for (let id = 1; id <= 96; id += 1) {
      const archived = await tx.query(
        `UPDATE tasks
         SET status = 'archived'::task_status,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING status::text AS status`,
        [id],
      );
      archivedRows += archived.rowCount;
      const final = await tx.query(
        `UPDATE tasks
         SET status = CASE WHEN id % 2 = 0 THEN 'done'::task_status ELSE 'blocked'::task_status END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING status::text AS status`,
        [id],
      );
      finalRows += final.rowCount;
    }
  });
  assertEqual(String(archivedRows), '96', 'archived update row count');
  assertEqual(String(finalRows), '96', 'final update row count');

  await executeStatements(db, [
    `INSERT INTO project_metrics (project_id, metric, value)
    SELECT project_id, 'done_tasks', count(*) FILTER (WHERE status = 'done')
    FROM tasks
    GROUP BY project_id
    ON CONFLICT (project_id, metric)
    DO UPDATE SET
      value = EXCLUDED.value,
      updated_at = CURRENT_TIMESTAMP`,
    `INSERT INTO project_metrics (project_id, metric, value)
    SELECT project_id, 'blocked_tasks', count(*) FILTER (WHERE status = 'blocked')
    FROM tasks
    GROUP BY project_id
    ON CONFLICT (project_id, metric)
    DO UPDATE SET
      value = EXCLUDED.value,
      updated_at = CURRENT_TIMESTAMP`,
  ]);
  return {archivedRows, finalRows};
}

async function executeStatements(
  db: Pick<OliphauntDatabase, 'execute'>,
  statements: readonly string[],
): Promise<void> {
  for (const statement of statements) {
    await db.execute(statement);
  }
}

async function measureRollupSelects(db: OliphauntDatabase): Promise<{
  p50: number;
  p90: number;
  p99: number;
  rows: string;
  doneRows: string;
  blockedRows: string;
  checksum: string;
}> {
  const selectTimes: number[] = [];
  let rows = '0';
  let doneRows = '0';
  let blockedRows = '0';
  let checksum = '0';
  for (let index = 0; index < 120; index += 1) {
    const started = now();
    const result = await db.query(
      `SELECT
         count(*)::text AS rows,
         count(*) FILTER (WHERE status = 'done')::text AS done_rows,
         count(*) FILTER (WHERE status = 'blocked')::text AS blocked_rows,
         coalesce(sum(estimate), 0)::text AS checksum
       FROM tasks
       WHERE priority >= $1
         AND labels && ARRAY[$2]::text[]`,
      [(index % 4) + 1, index % 2 === 0 ? 'mobile' : 'desktop'],
    );
    selectTimes.push(now() - started);
    if (index === 119) {
      rows = requiredText(result, 0, 'rows');
      doneRows = requiredText(result, 0, 'done_rows');
      blockedRows = requiredText(result, 0, 'blocked_rows');
      checksum = requiredText(result, 0, 'checksum');
    }
  }

  return {
    p50: percentile(selectTimes, 0.5),
    p90: percentile(selectTimes, 0.9),
    p99: percentile(selectTimes, 0.99),
    rows,
    doneRows,
    blockedRows,
    checksum,
  };
}

async function loadProjectRollup(db: OliphauntDatabase): Promise<ProjectRollup[]> {
  const result = await db.query(`
    SELECT
      name,
      total::text AS total,
      done::text AS done,
      blocked::text AS blocked,
      estimate::text AS estimate
    FROM task_dashboard
    ORDER BY id
  `);
  return result.rows.map((_, index) => ({
    name: requiredText(result, index, 'name'),
    total: requiredText(result, index, 'total'),
    done: requiredText(result, index, 'done'),
    blocked: requiredText(result, index, 'blocked'),
    estimate: requiredText(result, index, 'estimate'),
  }));
}

async function loadActivity(db: OliphauntDatabase): Promise<ActivityItem[]> {
  const result = await db.query(
    `SELECT title, owner, status::text AS status
     FROM tasks
     WHERE lower(title) LIKE lower($1)
     ORDER BY updated_at DESC, id DESC
     LIMIT 8`,
    ['%field operation%'],
  );
  return result.rows.map((_, index) => ({
    title: requiredText(result, index, 'title'),
    owner: requiredText(result, index, 'owner'),
    status: requiredText(result, index, 'status'),
  }));
}

async function scalar(db: OliphauntDatabase, sql: string): Promise<string> {
  const result = await db.query(sql);
  return requiredText(result, 0, 'value');
}

async function record(
  checks: OperationCheck[],
  name: string,
  run: () => Promise<string>,
  onStage?: (stage: WorkloadCheckStage) => void,
): Promise<void> {
  const started = now();
  onStage?.({name, status: 'start'});
  const detail = await run();
  const elapsedMs = now() - started;
  onStage?.({name, status: 'done', detail, elapsedMs});
  checks.push({
    name,
    detail,
    elapsedMs,
  });
}

async function expectPostgresError(
  run: () => Promise<unknown>,
  sqlstate: string,
): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof PostgresError) {
      assertEqual(error.sqlstate ?? '', sqlstate, 'PostgreSQL SQLSTATE');
      return error.sqlstate ?? '';
    }
    throw error;
  }
  throw new Error(`expected PostgreSQL error ${sqlstate}`);
}

async function expectPostgresPromiseError(
  promise: Promise<unknown>,
  sqlstate: string,
): Promise<string> {
  return expectPostgresError(() => promise, sqlstate);
}

async function expectMessage(run: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    const actual = error instanceof Error ? error.message : String(error);
    if (!actual.includes(message)) {
      throw new Error(`expected error containing ${message}, got ${actual}`);
    }
    return;
  }
  throw new Error(`expected error containing ${message}`);
}

function requiredText(result: QueryResult, row: number, column: string): string {
  const value = result.getText(row, column);
  if (value == null) {
    throw new Error(`query result missing ${column} at row ${row}`);
  }
  return value;
}

function assertEqual(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assertPositiveInteger(value: string, label: string): void {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label}: expected positive integer, got ${value}`);
  }
}

function assertGreaterThanBigInt(actual: string, expectedLowerBound: string, label: string): void {
  if (!/^[0-9]+$/.test(actual) || !/^[0-9]+$/.test(expectedLowerBound)) {
    throw new Error(
      `${label}: expected unsigned integer values, got ${actual} and ${expectedLowerBound}`,
    );
  }
  if (BigInt(actual) <= BigInt(expectedLowerBound)) {
    throw new Error(`${label}: expected ${actual} to be greater than ${expectedLowerBound}`);
  }
}

function postgresTextArray(values: readonly string[]): string {
  return `{${values.map(postgresArrayElement).join(',')}}`;
}

function postgresArrayElement(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index] ?? 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function now(): number {
  return globalThis.performance?.now() ?? Date.now();
}

const TASK_COUNT = 360;

const projectSeeds = [
  {
    id: 1,
    name: 'Dispatch',
    owner: 'Asha',
    health: 'green',
    budget: 125000,
    tags: ['mobile', 'ops'],
    metadata: {region: 'west', tier: 'critical'},
  },
  {
    id: 2,
    name: 'Inventory',
    owner: 'Mika',
    health: 'green',
    budget: 91000,
    tags: ['warehouse', 'sync'],
    metadata: {region: 'central', tier: 'core'},
  },
  {
    id: 3,
    name: 'Routing',
    owner: 'Noah',
    health: 'yellow',
    budget: 76000,
    tags: ['maps', 'mobile'],
    metadata: {region: 'east', tier: 'core'},
  },
  {
    id: 4,
    name: 'Billing',
    owner: 'Iris',
    health: 'green',
    budget: 132000,
    tags: ['finance', 'batch'],
    metadata: {region: 'west', tier: 'critical'},
  },
  {
    id: 5,
    name: 'Support',
    owner: 'Ren',
    health: 'yellow',
    budget: 68000,
    tags: ['customer', 'mobile'],
    metadata: {region: 'central', tier: 'growth'},
  },
  {
    id: 6,
    name: 'Compliance',
    owner: 'Leah',
    health: 'green',
    budget: 84000,
    tags: ['audit', 'policy'],
    metadata: {region: 'east', tier: 'critical'},
  },
] as const;

const owners = ['Asha', 'Mika', 'Noah', 'Iris', 'Ren', 'Leah', 'Omar', 'Vera'];
const regions = ['west', 'central', 'east'];

import { dbExec } from "./libsqlClient";

type Migration = { version: number; name: string; up: string[] };

const migrations: Migration[] = [
  {
    version: 1,
    name: "init_fixit_tables",
    up: [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );`,

      `CREATE TABLE IF NOT EXISTS envelope_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        monthly_budget_dollars REAL NOT NULL,
        due_by_day INTEGER NULL,
        due_amount_dollars REAL NULL,
        buffer_months INTEGER NOT NULL,
        priority_group TEXT NOT NULL,
        protected INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );`,

      `CREATE TABLE IF NOT EXISTS routing_baselines (
        pod_name TEXT PRIMARY KEY,
        bps INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );`,

      `CREATE TABLE IF NOT EXISTS routing_overrides (
        id TEXT PRIMARY KEY,
        pod_name TEXT NOT NULL,
        delta_bps INTEGER NOT NULL,
        remaining_deposits INTEGER NULL,
        expires_on TEXT NULL,
        reason TEXT NULL,
        created_by TEXT NULL,
        allow_protected_reduction INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );`,

      `CREATE INDEX IF NOT EXISTS idx_routing_overrides_pod ON routing_overrides(pod_name);`,

      `CREATE TABLE IF NOT EXISTS processed_messages (
        gmail_message_id TEXT PRIMARY KEY,
        thread_id TEXT NULL,
        from_email TEXT NULL,
        received_at TEXT NOT NULL
      );`,

      `CREATE TABLE IF NOT EXISTS message_logs (
        id TEXT PRIMARY KEY,
        gmail_message_id TEXT NULL,
        thread_id TEXT NULL,
        direction TEXT NOT NULL, -- 'in' | 'out'
        from_email TEXT NULL,
        subject TEXT NULL,
        body_text TEXT NULL,
        classification TEXT NULL,
        plan_json TEXT NULL,
        decision_token TEXT NULL,
        chosen_option TEXT NULL,
        created_at TEXT NOT NULL
      );`,

      `CREATE INDEX IF NOT EXISTS idx_message_logs_thread ON message_logs(thread_id);`,
      `CREATE INDEX IF NOT EXISTS idx_message_logs_from ON message_logs(from_email);`,

      `CREATE TABLE IF NOT EXISTS pod_balance_snapshots (
        date TEXT NOT NULL, -- YYYY-MM-DD (UTC)
        pod_name TEXT NOT NULL,
        balance_dollars REAL NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (date, pod_name)
      );`,

      `CREATE TABLE IF NOT EXISTS deposit_events (
        id TEXT PRIMARY KEY,
        deposit_amount_dollars REAL NOT NULL,
        raw_request_json TEXT NULL,
        created_at TEXT NOT NULL
      );`,
    ],
  },
  {
    version: 2,
    name: "add_envelope_rule_aliases",
    up: [`ALTER TABLE envelope_rules ADD COLUMN aliases_json TEXT NULL;`],
  },
];

function nowISO() {
  return new Date().toISOString();
}

export async function ensureMigrations(): Promise<void> {
  // Ensure migrations table exists (idempotent).
  await dbExec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );`
  );

  const applied = await dbExec(`SELECT version FROM schema_migrations;`);
  const appliedSet = new Set<number>(
    applied.rows.map((r: any) => Number((r as any).version ?? (r as any)[0]))
  );

  for (const m of migrations) {
    if (appliedSet.has(m.version)) continue;
    for (const stmt of m.up) {
      await dbExec(stmt);
    }
    await dbExec(`INSERT INTO schema_migrations(version, name, applied_at) VALUES(?, ?, ?);`, [
      m.version,
      m.name,
      nowISO(),
    ]);
  }
}


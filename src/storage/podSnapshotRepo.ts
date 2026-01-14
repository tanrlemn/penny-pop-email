import { dbExec, dbGetAll } from "./libsqlClient";

function nowISO() {
  return new Date().toISOString();
}

export async function upsertPodSnapshot(opts: {
  dateISO: string; // YYYY-MM-DD
  podName: string;
  balanceDollars: number;
}): Promise<void> {
  await dbExec(
    `INSERT INTO pod_balance_snapshots(date, pod_name, balance_dollars, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(date, pod_name) DO UPDATE SET balance_dollars=excluded.balance_dollars;`,
    [opts.dateISO, opts.podName, opts.balanceDollars, nowISO()]
  );
}

export async function getPodBalancesForDate(dateISO: string): Promise<Record<string, number>> {
  const rows = await dbGetAll<any>(`SELECT pod_name, balance_dollars FROM pod_balance_snapshots WHERE date = ?;`, [dateISO]);
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.pod_name)] = Number(r.balance_dollars);
  return out;
}


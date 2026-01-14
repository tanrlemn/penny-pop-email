import { randomUUID } from "node:crypto";
import { RoutingBaseline, RoutingOverride } from "../routing/types";
import { dbExec, dbGetAll } from "./libsqlClient";

function nowISO() {
  return new Date().toISOString();
}

function rowToBaseline(r: any): RoutingBaseline {
  return {
    podName: String(r.pod_name),
    bps: Number(r.bps),
    updatedAtISO: String(r.updated_at),
  };
}

function rowToOverride(r: any): RoutingOverride {
  return {
    id: String(r.id),
    podName: String(r.pod_name),
    deltaBps: Number(r.delta_bps),
    remainingDeposits: r.remaining_deposits == null ? null : Number(r.remaining_deposits),
    expiresOn: r.expires_on == null ? null : String(r.expires_on),
    reason: r.reason == null ? null : String(r.reason),
    createdBy: r.created_by == null ? null : String(r.created_by),
    allowProtectedReduction: Boolean(r.allow_protected_reduction),
    createdAtISO: String(r.created_at),
  };
}

export async function listRoutingBaselines(): Promise<RoutingBaseline[]> {
  const rows = await dbGetAll<any>(`SELECT * FROM routing_baselines ORDER BY pod_name ASC;`);
  return rows.map(rowToBaseline);
}

export async function getAllRoutingBaselines(): Promise<RoutingBaseline[]> {
  return listRoutingBaselines();
}

export async function upsertRoutingBaseline(podName: string, bps: number): Promise<void>;
export async function upsertRoutingBaseline(input: { envelopeName: string; bps: number }): Promise<void>;
export async function upsertRoutingBaseline(
  podNameOrInput: string | { envelopeName: string; bps: number },
  bpsArg?: number
): Promise<void> {
  const podName = typeof podNameOrInput === "string" ? podNameOrInput : podNameOrInput.envelopeName;
  const bps = typeof podNameOrInput === "string" ? (bpsArg ?? 0) : podNameOrInput.bps;
  await dbExec(
    `INSERT INTO routing_baselines(pod_name, bps, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(pod_name) DO UPDATE SET bps=excluded.bps, updated_at=excluded.updated_at;`,
    [podName, Math.trunc(bps), nowISO()]
  );
}

export async function listActiveRoutingOverrides(todayISO: string): Promise<RoutingOverride[]> {
  const rows = await dbGetAll<any>(
    `SELECT * FROM routing_overrides
     WHERE
       (remaining_deposits IS NULL OR remaining_deposits > 0)
       AND (expires_on IS NULL OR expires_on >= ?)
     ORDER BY datetime(created_at) ASC;`,
    [todayISO]
  );
  return rows.map(rowToOverride);
}

export async function insertRoutingOverride(input: Omit<RoutingOverride, "id" | "createdAtISO"> & { id?: string }): Promise<string> {
  const id = input.id ?? randomUUID();
  await dbExec(
    `INSERT INTO routing_overrides(
       id, pod_name, delta_bps, remaining_deposits, expires_on, reason, created_by, allow_protected_reduction, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      id,
      input.podName,
      Math.trunc(input.deltaBps),
      input.remainingDeposits ?? null,
      input.expiresOn ?? null,
      input.reason ?? null,
      input.createdBy ?? null,
      input.allowProtectedReduction ? 1 : 0,
      nowISO(),
    ]
  );
  return id;
}

export async function decrementOverrideDeposit(id: string): Promise<void> {
  await dbExec(
    `UPDATE routing_overrides
     SET remaining_deposits = CASE
       WHEN remaining_deposits IS NULL THEN NULL
       WHEN remaining_deposits <= 0 THEN 0
       ELSE remaining_deposits - 1
     END
     WHERE id = ?;`,
    [id]
  );
}


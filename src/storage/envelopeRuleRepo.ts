import { randomUUID } from "node:crypto";
import { EnvelopeRule, PriorityGroup } from "../envelopes/types";
import { dbExec, dbGetAll, dbGetOne } from "./libsqlClient";

function nowISO() {
  return new Date().toISOString();
}

function rowToRule(r: any): EnvelopeRule {
  return {
    id: String(r.id),
    name: String(r.name),
    monthlyBudgetDollars: Number(r.monthly_budget_dollars),
    dueByDay: r.due_by_day == null ? null : Number(r.due_by_day),
    dueAmountDollars: r.due_amount_dollars == null ? null : Number(r.due_amount_dollars),
    bufferMonths: Number(r.buffer_months),
    priorityGroup: String(r.priority_group) as PriorityGroup,
    protected: Boolean(r.protected),
    updatedAtISO: String(r.updated_at),
  };
}

export async function listEnvelopeRules(): Promise<EnvelopeRule[]> {
  const rows = await dbGetAll<any>(`SELECT * FROM envelope_rules ORDER BY name ASC;`);
  return rows.map(rowToRule);
}

export async function getAllEnvelopeRules(): Promise<EnvelopeRule[]> {
  return listEnvelopeRules();
}

export async function getEnvelopeRuleByName(name: string): Promise<EnvelopeRule | null> {
  const row = await dbGetOne<any>(`SELECT * FROM envelope_rules WHERE name = ?;`, [name]);
  return row ? rowToRule(row) : null;
}

export async function upsertEnvelopeRule(input: Omit<EnvelopeRule, "id" | "updatedAtISO"> & { id?: string }): Promise<void> {
  const id = input.id ?? randomUUID();
  const updatedAtISO = nowISO();
  await dbExec(
    `INSERT INTO envelope_rules(
      id, name, monthly_budget_dollars, due_by_day, due_amount_dollars, buffer_months, priority_group, protected, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      monthly_budget_dollars=excluded.monthly_budget_dollars,
      due_by_day=excluded.due_by_day,
      due_amount_dollars=excluded.due_amount_dollars,
      buffer_months=excluded.buffer_months,
      priority_group=excluded.priority_group,
      protected=excluded.protected,
      updated_at=excluded.updated_at;`,
    [
      id,
      input.name,
      input.monthlyBudgetDollars,
      input.dueByDay ?? null,
      input.dueAmountDollars ?? null,
      input.bufferMonths,
      input.priorityGroup,
      input.protected ? 1 : 0,
      updatedAtISO,
    ]
  );
}

export async function applyRuleChanges(envelopeName: string, changes: Partial<EnvelopeRule>): Promise<void> {
  const existing = await getEnvelopeRuleByName(envelopeName);
  if (!existing) throw new Error(`No EnvelopeRule found for: ${envelopeName}`);

  const next: EnvelopeRule = {
    ...existing,
    ...changes,
    // ensure these stay aligned with DB column names
    updatedAtISO: nowISO(),
  };

  await dbExec(
    `UPDATE envelope_rules
     SET monthly_budget_dollars = ?,
         due_by_day = ?,
         due_amount_dollars = ?,
         buffer_months = ?,
         priority_group = ?,
         protected = ?,
         updated_at = ?
     WHERE name = ?;`,
    [
      next.monthlyBudgetDollars,
      next.dueByDay ?? null,
      next.dueAmountDollars ?? null,
      next.bufferMonths,
      next.priorityGroup,
      next.protected ? 1 : 0,
      next.updatedAtISO,
      envelopeName,
    ]
  );
}


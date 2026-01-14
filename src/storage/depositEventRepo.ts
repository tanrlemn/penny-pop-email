import { dbExec } from "./libsqlClient";

function nowISO() {
  return new Date().toISOString();
}

export async function tryInsertDepositEvent(opts: {
  id: string;
  depositAmountDollars: number;
  rawRequestJson?: string | null;
}): Promise<boolean> {
  const res = await dbExec(
    `INSERT OR IGNORE INTO deposit_events(id, deposit_amount_dollars, raw_request_json, created_at)
     VALUES (?, ?, ?, ?);`,
    [opts.id, opts.depositAmountDollars, opts.rawRequestJson ?? null, nowISO()]
  );
  return res.rowsAffected > 0;
}


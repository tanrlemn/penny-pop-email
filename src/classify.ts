import { config } from "./config";
import { SequenceAccount, Snapshot } from "./types";

export interface SavingsComputation {
  savingsTotal: number;
  partial: boolean;
  missing: string[];
}

export function computeSavings(accounts: SequenceAccount[]): SavingsComputation {
  const byName = new Map(accounts.map((a) => [a.name, a]));
  const missing: string[] = [];
  let total = 0;

  for (const name of config.classification.savingsNames) {
    const acct = byName.get(name);
    if (!acct || acct.balanceDollars == null) {
      missing.push(name);
      continue;
    }
    total += acct.balanceDollars;
  }

  return {
    savingsTotal: round2(total),
    partial: missing.length > 0,
    missing,
  };
}

export function snapshotForToday(todayISO: string, computed: SavingsComputation): Snapshot {
  return {
    date: todayISO,
    savingsTotal: computed.savingsTotal,
    ...(computed.partial ? { partial: true, missing: computed.missing } : {}),
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}



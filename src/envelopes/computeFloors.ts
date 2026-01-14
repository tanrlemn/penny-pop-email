import { SequenceAccount } from "../types";
import { EnvelopeRule, EnvelopeState } from "./types";

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function utcTodayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function computeEnvelopeStates(opts: {
  accounts: SequenceAccount[];
  rules: EnvelopeRule[];
}): EnvelopeState[] {
  const { accounts, rules } = opts;
  const byName = new Map(accounts.filter((a) => a.type === "Pod").map((a) => [a.name, a]));

  const todayISO = utcTodayISO();
  const today = new Date(todayISO + "T00:00:00Z");
  const todayDay = today.getUTCDate();

  return rules.map((r) => {
    const acct = byName.get(r.name);
    const balance = acct?.balanceDollars ?? null;
    const requiredFloor = round2(r.monthlyBudgetDollars * r.bufferMonths);

    const dueAmount = r.dueAmountDollars ?? r.monthlyBudgetDollars;
    const requiredByDue =
      typeof r.dueByDay === "number" && r.dueByDay > 0 ? round2(requiredFloor + dueAmount) : undefined;

    const availableToSpend = balance == null ? null : round2(balance - requiredFloor);

    // Status assignment is refined in detectIssues; here we compute minimal signals.
    let status: EnvelopeState["status"] = "OK";
    let statusReason: string | undefined;

    if (availableToSpend != null && availableToSpend < 0) {
      status = "buffer_breached";
      statusReason = `Below required floor by $${Math.abs(availableToSpend).toFixed(2)}.`;
    }

    // Lightweight due-soon signal (true logic in detectIssues).
    if (
      balance != null &&
      requiredByDue != null &&
      typeof r.dueByDay === "number" &&
      r.dueByDay > 0 &&
      balance < requiredByDue &&
      todayDay <= r.dueByDay
    ) {
      status = "due_soon";
      statusReason = `Needs $${round2(requiredByDue - balance).toFixed(2)} by day ${r.dueByDay}.`;
    }

    return {
      name: r.name,
      balanceDollars: balance,
      monthlyBudgetDollars: r.monthlyBudgetDollars,
      dueByDay: r.dueByDay ?? null,
      dueAmountDollars: dueAmount,
      bufferMonths: r.bufferMonths,
      requiredFloorDollars: requiredFloor,
      requiredByDueDollars: requiredByDue,
      availableToSpendDollars: availableToSpend,
      status,
      statusReason,
      priorityGroup: r.priorityGroup,
      protected: r.protected,
    };
  });
}


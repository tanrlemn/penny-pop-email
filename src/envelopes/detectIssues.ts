import { DetectedIssue, EnvelopeState } from "./types";

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function daysInMonthUTC(year: number, month1to12: number) {
  // month1to12: 1..12
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

function clampDayOfMonthUTC(year: number, month1to12: number, day: number) {
  const dim = daysInMonthUTC(year, month1to12);
  return Math.min(Math.max(day, 1), dim);
}

function addMonthsUTC(date: Date, months: number): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function isoForUTCDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function nextDueDateISO(todayISO: string, dueByDay: number): { dueISO: string; daysUntil: number } {
  const today = new Date(todayISO + "T00:00:00Z");
  const y = today.getUTCFullYear();
  const m0 = today.getUTCMonth(); // 0-11
  const todayDay = today.getUTCDate();

  // Candidate in current month
  const dueDayThisMonth = clampDayOfMonthUTC(y, m0 + 1, dueByDay);
  const thisMonthDue = new Date(Date.UTC(y, m0, dueDayThisMonth));

  let due = thisMonthDue;
  if (todayDay > dueDayThisMonth) {
    const nextMonth = addMonthsUTC(today, 1);
    const y2 = nextMonth.getUTCFullYear();
    const m2 = nextMonth.getUTCMonth();
    const dueDayNextMonth = clampDayOfMonthUTC(y2, m2 + 1, dueByDay);
    due = new Date(Date.UTC(y2, m2, dueDayNextMonth));
  }

  const msPerDay = 24 * 60 * 60 * 1000;
  const daysUntil = Math.round((due.getTime() - today.getTime()) / msPerDay);
  return { dueISO: isoForUTCDate(due), daysUntil };
}

function dueDateThisMonthISO(todayISO: string, dueByDay: number): string {
  const today = new Date(todayISO + "T00:00:00Z");
  const y = today.getUTCFullYear();
  const m0 = today.getUTCMonth();
  const dueDay = clampDayOfMonthUTC(y, m0 + 1, dueByDay);
  return isoForUTCDate(new Date(Date.UTC(y, m0, dueDay)));
}

export function detectIssues(opts: {
  states: EnvelopeState[];
  todayISO: string;
  dueSoonWindowDays: number;
  dueDateSnapshotBalances?: Record<string, number | null | undefined>;
}): { states: EnvelopeState[]; issues: DetectedIssue[] } {
  const { states, todayISO, dueSoonWindowDays, dueDateSnapshotBalances = {} } = opts;
  const todayDay = new Date(todayISO + "T00:00:00Z").getUTCDate();

  const issues: DetectedIssue[] = [];

  const nextStates = states.map((s) => {
    let status: EnvelopeState["status"] = "OK";
    let statusReason: string | undefined;

    const bal = s.balanceDollars;

    const available = s.availableToSpendDollars;
    const requiredByDue = s.requiredByDueDollars;
    const dueByDay = s.dueByDay ?? null;

    // 1) Overdue (best-effort, prefers snapshot on due date)
    if (bal != null && requiredByDue != null && typeof dueByDay === "number" && dueByDay > 0 && todayDay > dueByDay) {
      const dueThisMonth = dueDateThisMonthISO(todayISO, dueByDay);
      const snapBal = dueDateSnapshotBalances[s.name];

      const compareBal = typeof snapBal === "number" ? snapBal : bal;
      if (compareBal < requiredByDue) {
        status = "overdue";
        const short = round2(requiredByDue - compareBal);
        statusReason =
          typeof snapBal === "number"
            ? `Was short $${short.toFixed(2)} on due date (${dueThisMonth}).`
            : `Likely short $${short.toFixed(2)} for due date (no snapshot for ${dueThisMonth}).`;
      }
    }

    // 2) Due soon (upcoming due date)
    if (
      status !== "overdue" &&
      bal != null &&
      requiredByDue != null &&
      typeof dueByDay === "number" &&
      dueByDay > 0
    ) {
      const { daysUntil } = nextDueDateISO(todayISO, dueByDay);
      if (daysUntil >= 0 && daysUntil <= dueSoonWindowDays && bal < requiredByDue) {
        status = "due_soon";
        const short = round2(requiredByDue - bal);
        statusReason = `Needs $${short.toFixed(2)} funded within ${daysUntil} day(s).`;
      }
    }

    // 3) Buffer breach / overspend
    if (status === "OK" && available != null && available < 0) {
      status = "buffer_breached";
      statusReason = `Below floor by $${Math.abs(available).toFixed(2)}.`;
    }

    return { ...s, status, statusReason };
  });

  for (const s of nextStates) {
    const bal = s.balanceDollars;

    if (bal == null) continue; // can't reason without balance

    if (s.status === "due_soon" || s.status === "overdue") {
      const requiredByDue = s.requiredByDueDollars ?? 0;
      const shortfall = Math.max(0, round2(requiredByDue - bal));
      if (shortfall > 0) {
        issues.push({
          type: "timing_shortfall",
          envelopeName: s.name,
          severity: s.status === "overdue" ? "error" : "warn",
          shortfallDollars: shortfall,
          reason: s.statusReason ?? "Needs funding by due date.",
        });
      }
      continue;
    }

    if (s.status === "buffer_breached") {
      const shortfall = Math.max(0, round2(-(s.availableToSpendDollars ?? 0)));
      issues.push({
        type: "overspend",
        envelopeName: s.name,
        severity: "warn",
        shortfallDollars: shortfall,
        reason: s.statusReason ?? "Below buffer floor.",
      });
      continue;
    }
  }

  return { states: nextStates, issues };
}


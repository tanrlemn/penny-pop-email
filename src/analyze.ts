import { config } from "./config";
import { Snapshot, Status } from "./types";

export function analyze(snapshots: Snapshot[], todayISO: string): Status {
  const lookbackDays = config.thresholds.lookbackDays;

  const todaySnap = snapshots.find((s) => s.date === todayISO);
  if (!todaySnap) {
    return {
      level: "YELLOW",
      reasonCode: "BASELINE",
      lookbackDays,
      reason: "No snapshot found for today yet.",
    };
  }

  if (todaySnap.partial === true) {
    const missing = (todaySnap.missing ?? []).join(", ");
    return {
      level: "YELLOW",
      reasonCode: "MISSING_DATA",
      lookbackDays,
      reason: missing
        ? `Balance unavailable for: ${missing}. Trend is not computed for partial days.`
        : "Data incomplete today; trend is not computed for partial days.",
    };
  }

  const targetDate = daysAgoISO(todayISO, lookbackDays);
  const comparison = findNonPartialLookback(snapshots, targetDate, config.alerts.lookbackSearchWindowDays);

  if (!comparison) {
    return {
      level: "YELLOW",
      reasonCode: "BASELINE",
      lookbackDays,
      reason: `Collecting baseline; no trend yet (need a non-partial snapshot near ${targetDate}).`,
    };
  }

  const delta = round2(todaySnap.savingsTotal - comparison.savingsTotal);
  const slopePerDay = round2(delta / lookbackDays);
  const projectedMonthly = round2(slopePerDay * 30);

  const flat = config.thresholds.flatBandDollars;
  const redDown = config.thresholds.redDownDollarsOverLookback;

  if (delta < -redDown) {
    return {
      level: "RED",
      reasonCode: "DOWN",
      lookbackDays,
      delta,
      slopePerDay,
      projectedMonthly,
      reason: `Savings down $${Math.abs(delta).toFixed(2)} over ${lookbackDays} days.`,
    };
  }

  if (Math.abs(delta) <= flat) {
    return {
      level: "YELLOW",
      reasonCode: "FLAT",
      lookbackDays,
      delta,
      slopePerDay,
      projectedMonthly,
      reason: `Savings roughly flat (±$${flat}) over ${lookbackDays} days.`,
    };
  }

  if (delta < 0) {
    return {
      level: "YELLOW",
      reasonCode: "DOWN",
      lookbackDays,
      delta,
      slopePerDay,
      projectedMonthly,
      reason: `Savings down $${Math.abs(delta).toFixed(2)} over ${lookbackDays} days.`,
    };
  }

  return {
    level: "GREEN",
    reasonCode: "UP",
    lookbackDays,
    delta,
    slopePerDay,
    projectedMonthly,
    reason: `Savings up $${delta.toFixed(2)} over ${lookbackDays} days.`,
  };
}

function findNonPartialLookback(
  snapshots: Snapshot[],
  targetDateISO: string,
  windowDays: number
): Snapshot | undefined {
  for (let i = 0; i <= windowDays; i++) {
    const date = daysAgoISO(targetDateISO, i);
    const snap = snapshots.find((s) => s.date === date);
    if (snap && snap.partial !== true) return snap;
  }
  return undefined;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function daysAgoISO(todayISO: string, days: number): string {
  const d = new Date(todayISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}



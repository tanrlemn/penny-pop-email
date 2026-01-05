import { config } from "./config";
import { Snapshot, Status } from "./types";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatUSD(amount: number): string {
  return usd.format(amount);
}

function statusLineFor(status: Status): string {
  if (status.reasonCode === "BASELINE") {
    // Intentionally avoid "YELLOW" here; baseline is not a problem state.
    return "Status: BASELINE (Collecting history)";
  }
  return `Status: ${status.level} (${status.reasonCode})`;
}

export function subjectFor(status: Status): string {
  if (status.level === "RED") return "Savings trend alert: action recommended";
  if (status.reasonCode === "MISSING_DATA") return "Savings update: data incomplete today";
  if (status.reasonCode === "BASELINE") return "Savings update: collecting baseline";
  if (status.reasonCode === "DOWN") return "Savings update: slight dip";
  if (status.level === "YELLOW") return "Savings update: small adjustment recommended";
  return "Savings update: still on track";
}

export function recommendationFor(status: Status): string {
  if (status.level === "RED") {
    return "Recommended: pause discretionary spending for 7 days and review any large upcoming expenses.";
  }
  if (status.reasonCode === "MISSING_DATA") {
    return "Recommended: check the missing account connections and re-run tomorrow.";
  }
  if (status.reasonCode === "BASELINE") {
    return "Recommendation: No action needed.";
  }
  if (status.reasonCode === "DOWN") {
    return "Recommended: tighten discretionary spending for the next 7 days.";
  }
  if (status.reasonCode === "FLAT") {
    return "Recommended: keep discretionary spending tight for the next 7 days.";
  }
  return "Recommended: no changes.";
}

export function bodyFor(opts: {
  todayISO: string;
  status: Status;
  todaySnapshot: Snapshot;
}): string {
  const { todayISO, status, todaySnapshot } = opts;

  const lines: string[] = [];

  lines.push(`Date: ${todayISO}`);
  lines.push(statusLineFor(status));
  lines.push("");

  const isPartial = todaySnapshot.partial === true;
  lines.push(
    `Savings Total (today${isPartial ? ", provisional" : ""}): ${formatUSD(todaySnapshot.savingsTotal)}`
  );

  if (typeof status.delta === "number") {
    lines.push(
      `Change over last ${status.lookbackDays} days: ${
        status.delta >= 0 ? "+" : "-"
      }${formatUSD(Math.abs(status.delta))}`
    );
  }

  if (typeof status.slopePerDay === "number") {
    lines.push(
      `Weekly slope (avg/day): ${status.slopePerDay >= 0 ? "+" : "-"}${formatUSD(
        Math.abs(status.slopePerDay)
      )}`
    );
  }

  if (typeof status.projectedMonthly === "number") {
    lines.push(
      `Projected monthly change (at this pace): ${
        status.projectedMonthly >= 0 ? "+" : "-"
      }${formatUSD(Math.abs(status.projectedMonthly))}`
    );
  }

  lines.push("");
  lines.push(status.reason);

  if (isPartial) {
    const missing = todaySnapshot.missing ?? [];
    lines.push("");
    lines.push("Data incomplete today; trend may be unreliable.");
    if (missing.length > 0) {
      lines.push(`Missing balances: ${missing.join(", ")}`);
    }
  }

  lines.push("");
  lines.push(recommendationFor(status));
  lines.push("");
  lines.push("Tracked savings accounts:");
  for (const name of config.classification.savingsNames) {
    lines.push(`• ${name}`);
  }

  return lines.join("\n");
}



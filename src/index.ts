import "dotenv/config";
import { config } from "./config";
import { fetchAccounts } from "./sequenceClient";
import { computeSavings, snapshotForToday } from "./classify";
import { loadState, saveState, upsertSnapshot } from "./snapshotStore";
import { analyze } from "./analyze";
import { sendEmail } from "./email";
import { bodyFor, subjectFor } from "./templates";
import { PersistedStateV1, Snapshot } from "./types";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysBetweenISO(olderISO: string, newerISO: string): number {
  const a = new Date(olderISO + "T00:00:00Z").getTime();
  const b = new Date(newerISO + "T00:00:00Z").getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

function isWeeklyDay(now: Date): boolean {
  return now.getUTCDay() === config.cadence.emailWeeklyOnDay;
}

function shouldSuppressRedDueToCooldown(state: PersistedStateV1, today: string): boolean {
  const last = state.lastAlert;
  if (!last || last.level !== "RED") return false;
  const diff = daysBetweenISO(last.date, today);
  return diff <= config.alerts.redCooldownDays;
}

async function main() {
  const now = new Date();
  const today = todayISO();

  const accounts = await fetchAccounts();
  const computed = computeSavings(accounts);
  const todaySnapshot = snapshotForToday(today, computed);

  const state = await loadState();
  const nextSnapshots = upsertSnapshot(state.snapshots, todaySnapshot);

  // Persist snapshots even if emailing fails later.
  await saveState({ ...state, snapshots: nextSnapshots });

  const status = analyze(nextSnapshots, today);

  const weekly = isWeeklyDay(now);
  const baselineOnly = status.reasonCode === "BASELINE";
  const missingData = status.reasonCode === "MISSING_DATA";

  let shouldEmail = false;
  if (weekly) {
    shouldEmail = true;
  } else if (baselineOnly || missingData) {
    shouldEmail = false;
  } else if (config.cadence.alwaysEmailOnRed && status.level === "RED") {
    shouldEmail = !shouldSuppressRedDueToCooldown(state, today);
  }

  if (!shouldEmail) {
    console.log(`[${today}] No email sent. Status=${status.level} (${status.reasonCode}).`);
    return;
  }

  // Use the just-written snapshot for email context (includes partial/missing).
  const snapForEmail: Snapshot = todaySnapshot;
  const subject = subjectFor(status);
  const text = bodyFor({ todayISO: today, status, todaySnapshot: snapForEmail });

  await sendEmail({
    to: config.email.to,
    from: config.email.from,
    subject,
    text,
  });

  console.log(`[${today}] Email sent. Status=${status.level} (${status.reasonCode}).`);

  // Update lastAlert only when an email is actually sent, and only for RED/YELLOW.
  if (status.level === "RED" || status.level === "YELLOW") {
    await saveState({
      ...state,
      snapshots: nextSnapshots,
      lastAlert: { level: status.level, date: today },
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});



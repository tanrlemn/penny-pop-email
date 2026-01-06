import "dotenv/config";
import { config } from "./config";
import { fetchAccounts } from "./sequenceClient";
import { computeSavings, snapshotForToday } from "./classify";
import { loadState, saveState, upsertSnapshot } from "./snapshotStore";
import { analyze } from "./analyze";
import { sendEmail } from "./email";
import { bodyFor, subjectFor } from "./templates";
import { Snapshot } from "./types";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const today = todayISO();

  const accounts = await fetchAccounts();
  const computed = computeSavings(accounts);
  const todaySnapshot = snapshotForToday(today, computed);

  const state = await loadState();
  const nextSnapshots = upsertSnapshot(state.snapshots, todaySnapshot);

  // Persist snapshots even if emailing fails later.
  await saveState({ ...state, snapshots: nextSnapshots });

  const status = analyze(nextSnapshots, today);

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



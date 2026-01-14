import { ensureMigrations } from "./migrations";

let ensured = false;

export async function initDb(): Promise<void> {
  if (ensured) return;
  await ensureMigrations();
  ensured = true;
}


import "dotenv/config";
import { pollFixitOnce } from "./emailFixit/poller";

function getEnvNumber(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const intervalSeconds = getEnvNumber("FIXIT_POLL_INTERVAL_SECONDS", 60);
  console.log(`Fixit poller starting. Interval=${intervalSeconds}s`);

  // Simple forever-loop worker. If you deploy to a process manager, it can restart on crash.
  while (true) {
    try {
      await pollFixitOnce();
    } catch (err) {
      console.error("Fixit poll error:", err);
    }
    await sleep(intervalSeconds * 1000);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


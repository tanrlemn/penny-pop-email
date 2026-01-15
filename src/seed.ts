import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { initDb } from "./storage/initDb";
import { upsertEnvelopeRule } from "./storage/envelopeRuleRepo";
import { upsertRoutingBaseline } from "./storage/routingRepo";
import { EnvelopeRule } from "./envelopes/types";

type SeedEnvelopeRule = Omit<EnvelopeRule, "id" | "updatedAtISO"> & { id?: string };
type SeedBaseline = { podName: string; bps: number };

function readJson<T>(p: string): T {
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw) as T;
}

function resolveSeedPath(relOrAbs: string) {
  return path.isAbsolute(relOrAbs) ? relOrAbs : path.join(process.cwd(), relOrAbs);
}

async function main() {
  const rulesPath = resolveSeedPath(process.argv[2] ?? "seed/envelopeRules.example.json");
  const baselinesPath = resolveSeedPath(process.argv[3] ?? "seed/routingBaselines.example.json");

  await initDb();

  if (fs.existsSync(rulesPath)) {
    const rules = readJson<SeedEnvelopeRule[]>(rulesPath);
    for (const r of rules) {
      await upsertEnvelopeRule({
        id: r.id,
        name: r.name,
        aliases: r.aliases,
        monthlyBudgetDollars: r.monthlyBudgetDollars,
        dueByDay: r.dueByDay ?? null,
        dueAmountDollars: r.dueAmountDollars ?? null,
        bufferMonths: r.bufferMonths,
        priorityGroup: r.priorityGroup,
        protected: r.protected,
      });
    }
    console.log(`Seeded ${rules.length} envelope rule(s) from ${rulesPath}`);
  } else {
    console.log(`Rules seed file not found at ${rulesPath} (skipping)`);
  }

  if (fs.existsSync(baselinesPath)) {
    const baselines = readJson<SeedBaseline[]>(baselinesPath);
    for (const b of baselines) {
      await upsertRoutingBaseline(b.podName, b.bps);
    }
    console.log(`Seeded ${baselines.length} routing baseline(s) from ${baselinesPath}`);
  } else {
    console.log(`Baselines seed file not found at ${baselinesPath} (skipping)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


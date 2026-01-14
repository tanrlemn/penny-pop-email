import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { initDb } from "../storage/initDb";
import { getAllEnvelopeRules, upsertEnvelopeRule } from "../storage/envelopeRuleRepo";
import { getAllRoutingBaselines, upsertRoutingBaseline } from "../storage/routingRepo";
import { PriorityGroup } from "../envelopes/types";

type EnvelopeOverride = {
  dueByDay?: number;
  bufferMonths?: number;
  dueAmountDollars?: number;
};

type ParsedEnvelope = {
  name: string;
  budget: number;
};

const EXPECTED_BUDGETED_EXPENSES = 9389;

function resolvePath(relOrAbs: string) {
  return path.isAbsolute(relOrAbs) ? relOrAbs : path.join(process.cwd(), relOrAbs);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field.trim());
      field = "";
    } else if (char === "\n") {
      row.push(field.trim());
      field = "";
      if (row.some((value) => value.length > 0)) {
        rows.push(row);
      }
      row = [];
    } else if (char === "\r") {
      // ignore
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field.trim());
    if (row.some((value) => value.length > 0)) {
      rows.push(row);
    }
  }

  return rows;
}

function parseDollar(raw: string): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const isParenNegative = trimmed.startsWith("(") && trimmed.endsWith(")");
  const cleaned = trimmed.replace(/[(),$]/g, "").replace(/,/g, "");
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  return isParenNegative ? -num : num;
}

function indexFor(headers: string[], name: string): number {
  const idx = headers.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  return idx;
}

function readCsvRows(filePath: string): { headers: string[]; rows: string[][] } {
  const raw = fs.readFileSync(filePath, "utf8");
  const rows = parseCsv(raw);
  if (rows.length === 0) {
    throw new Error(`CSV appears empty: ${filePath}`);
  }
  const headers = rows[0];
  return { headers, rows: rows.slice(1) };
}

function loadOverrides(overridesPath: string): Record<string, EnvelopeOverride> {
  if (!fs.existsSync(overridesPath)) return {};
  const raw = fs.readFileSync(overridesPath, "utf8");
  return JSON.parse(raw) as Record<string, EnvelopeOverride>;
}

function toMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

async function main() {
  const [expensesArg, incomeArg] = process.argv.slice(2);
  if (!expensesArg) {
    throw new Error("Usage: npm run budget:sync -- <expenses.csv> [income.csv]");
  }

  const expensesPath = resolvePath(expensesArg);
  const incomePath = incomeArg ? resolvePath(incomeArg) : null;
  const overridesPath = resolvePath(process.env.BUDGET_OVERRIDES_PATH ?? "seed/envelopeOverrides.json");

  if (!fs.existsSync(expensesPath)) {
    throw new Error(`Expenses CSV not found: ${expensesPath}`);
  }

  const { headers, rows } = readCsvRows(expensesPath);
  const envelopeIdx = indexFor(headers, "Envelope");
  const budgetIdx = indexFor(headers, "Budget");
  if (envelopeIdx === -1 || budgetIdx === -1) {
    throw new Error(`Expenses CSV missing Envelope/Budget headers: ${expensesPath}`);
  }

  const envelopeMap = new Map<string, ParsedEnvelope>();
  for (const row of rows) {
    const envelope = (row[envelopeIdx] ?? "").trim();
    const budget = parseDollar(row[budgetIdx] ?? "");
    if (!envelope || budget === null) continue;
    const existing = envelopeMap.get(envelope);
    if (existing) {
      existing.budget += budget;
    } else {
      envelopeMap.set(envelope, { name: envelope, budget });
    }
  }

  const envelopes = Array.from(envelopeMap.values());
  const totalBudgetedExpenses = envelopes.reduce((sum, env) => sum + env.budget, 0);

  if (envelopes.length === 0 || totalBudgetedExpenses <= 0) {
    throw new Error(`No valid envelope budgets found in ${expensesPath}`);
  }

  if (Math.abs(totalBudgetedExpenses - EXPECTED_BUDGETED_EXPENSES) > 1) {
    console.warn(
      `Warning: total budgeted expenses ${toMoney(totalBudgetedExpenses)} differs from expected ${toMoney(
        EXPECTED_BUDGETED_EXPENSES
      )}`
    );
  }

  let totalIncome: number | null = null;
  if (incomePath && fs.existsSync(incomePath)) {
    const incomeCsv = readCsvRows(incomePath);
    const incomeEnvelopeIdx = indexFor(incomeCsv.headers, "Envelope");
    const incomeBudgetIdx = indexFor(incomeCsv.headers, "Budget");
    if (incomeEnvelopeIdx === -1 || incomeBudgetIdx === -1) {
      console.warn(`Income CSV missing Envelope/Budget headers: ${incomePath}`);
    } else {
      totalIncome = incomeCsv.rows.reduce((sum, row) => {
        const envelope = (row[incomeEnvelopeIdx] ?? "").trim();
        const budget = parseDollar(row[incomeBudgetIdx] ?? "");
        if (!envelope || budget === null) return sum;
        return sum + budget;
      }, 0);
    }
  }

  const overrides = loadOverrides(overridesPath);
  if (Object.keys(overrides).length > 0) {
    console.log(`Loaded envelope overrides from ${overridesPath}`);
  } else {
    console.log(`No envelope overrides found at ${overridesPath} (using defaults)`);
  }

  await initDb();

  const existingRules = await getAllEnvelopeRules();
  const existingRulesByName = new Map(existingRules.map((rule) => [rule.name, rule]));
  const existingBaselines = await getAllRoutingBaselines();
  const existingBaselineByName = new Map(existingBaselines.map((baseline) => [baseline.podName, baseline]));

  const budgetDiffs: string[] = [];
  let oldTotalForImported = 0;

  for (const env of envelopes) {
    const existing = existingRulesByName.get(env.name);
    const override = overrides[env.name] ?? {};
    const priorityGroup: PriorityGroup = existing?.priorityGroup ?? "Other";
    const protectedFlag = existing?.protected ?? false;

    if (existing) oldTotalForImported += existing.monthlyBudgetDollars;

    const dueByDay = override.dueByDay ?? null;
    const bufferMonths = override.bufferMonths ?? 0;
    const dueAmountDollars = override.dueAmountDollars ?? env.budget;

    await upsertEnvelopeRule({
      id: existing?.id,
      name: env.name,
      monthlyBudgetDollars: env.budget,
      dueByDay,
      dueAmountDollars,
      bufferMonths,
      priorityGroup,
      protected: protectedFlag,
    });

    if (!existing || existing.monthlyBudgetDollars !== env.budget) {
      const oldValue = existing ? toMoney(existing.monthlyBudgetDollars) : "(new)";
      budgetDiffs.push(`${env.name}: ${oldValue} -> ${toMoney(env.budget)}`);
    }
  }

  const bpsMap = new Map<string, number>();
  for (const env of envelopes) {
    const bps = Math.round((env.budget / totalBudgetedExpenses) * 10000);
    bpsMap.set(env.name, bps);
  }

  const catchAllName = process.env.ROUTING_CATCH_ALL_POD ?? "Move to ___";
  const currentCatchAll = bpsMap.get(catchAllName) ?? 0;
  const sumBps = Array.from(bpsMap.values()).reduce((sum, bps) => sum + bps, 0);
  const remainder = 10000 - sumBps;
  bpsMap.set(catchAllName, currentCatchAll + remainder);

  for (const [envelopeName, bps] of bpsMap.entries()) {
    await upsertRoutingBaseline({ envelopeName, bps });
  }

  console.log("Parsed totals:");
  console.log(`- totalBudgetedExpenses: ${toMoney(totalBudgetedExpenses)}`);
  if (totalIncome !== null) {
    console.log(`- totalIncome: ${toMoney(totalIncome)}`);
  }
  console.log(`- count of envelopes imported: ${envelopes.length}`);
  console.log(`- DB total (imported envelopes): ${toMoney(oldTotalForImported)} -> ${toMoney(totalBudgetedExpenses)}`);

  console.log("Envelope budget diffs:");
  if (budgetDiffs.length === 0) {
    console.log("- (no changes)");
  } else {
    for (const diff of budgetDiffs.sort()) {
      console.log(`- ${diff}`);
    }
  }

  const finalSum = Array.from(bpsMap.values()).reduce((sum, bps) => sum + bps, 0);
  console.log("Routing bps summary:");
  console.log(`- sum bps: ${finalSum}`);
  console.log(`- catch-all remainder applied: ${remainder} to ${catchAllName}`);

  const topBps = Array.from(bpsMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, bps]) => `${name}: ${bps}`);
  console.log(`- top 10 bps allocations: ${topBps.join(", ")}`);

  if (existingBaselineByName.size === 0) {
    console.log("Note: no existing routing baselines were found before upsert.");
  }

  console.log("✅ Budget sync complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

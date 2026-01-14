import { EnvelopeState, FixPlan, FixPlanOption, PlanStep } from "../envelopes/types";
import { Phase } from "./parseEmail";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatUSD(n: number) {
  return usd.format(n);
}

function stepLines(step: PlanStep): string[] {
  if (step.kind === "transfer") {
    return [`- Transfer ${formatUSD(step.amountDollars)} from ${step.fromEnvelope} → ${step.toEnvelope}`];
  }
  if (step.kind === "routing_override") {
    const sign = step.deltaBps >= 0 ? "+" : "-";
    return [`- For next ${step.remainingDeposits} deposit(s): ${sign}${Math.abs(step.deltaBps)} bps on ${step.envelope}`];
  }
  return [
    `- Update rule for ${step.envelope}: ${Object.entries(step.changes)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`,
  ];
}

function optionBlock(option: FixPlanOption, recommended: boolean): string[] {
  const lines: string[] = [];
  lines.push(`${option.optionId}) ${option.label}${recommended ? " (recommended)" : ""}`);
  lines.push(`Type: ${option.vocabulary}`);
  lines.push(option.summary);
  if (option.steps.length > 0) {
    lines.push("Steps:");
    for (const s of option.steps) lines.push(...stepLines(s));
  }
  if (option.warnings && option.warnings.length > 0) {
    lines.push("Notes:");
    for (const w of option.warnings) lines.push(`- ${w}`);
  }
  return lines;
}

function orderedOptions(plan: FixPlan): FixPlanOption[] {
  const rec = plan.options.find((o) => o.optionId === plan.recommendedOptionId);
  const rest = plan.options.filter((o) => o.optionId !== plan.recommendedOptionId);
  return rec ? [rec, ...rest] : plan.options.slice();
}

function introLine(phase: Phase): string {
  if (phase === "ON_TRIP") return "Got it. Keeping this minimal and low-stress.";
  if (phase === "PRE_TRIP") return "Got it. Here are safe, low-drama options before the trip.";
  return "Got it. Here are grounded options based on current balances + your rules.";
}

function appendContextBlock(lines: string[], contextText?: string) {
  const clean = (contextText ?? "").trim();
  if (!clean) return;

  lines.push("");
  lines.push("---");
  lines.push("Your message:");
  for (const line of clean.split(/\r?\n/)) {
    lines.push(`> ${line}`);
  }
  lines.push("---");
}

export function composeFixitReply(opts: {
  decisionToken: string;
  plans: FixPlan[];
  states: EnvelopeState[];
  phase: Phase;
  contextText?: string;
}): { subject: string; text: string } {
  const { decisionToken, plans, phase, contextText } = opts;

  const subject = plans.length === 0 ? "Fixit: no issues detected" : "Fixit: options to resolve";
  const lines: string[] = [];

  lines.push(introLine(phase));

  lines.push("");
  lines.push(`Decision token: ${decisionToken}`);
  lines.push("To apply an option, reply with: APPLY A (or B/C). You can also add the token: APPLY A " + decisionToken);
  lines.push("");

  if (plans.length === 0) {
    lines.push("I didn’t detect any buffer/due-date issues right now based on current balances.");
    appendContextBlock(lines, contextText);
    return { subject, text: lines.join("\n") };
  }

  for (const plan of plans.slice(0, 3)) {
    lines.push(`Issue: ${plan.issue.envelopeName}`);
    lines.push(`Type: ${plan.issue.type}`);
    lines.push(`Shortfall: ${formatUSD(plan.issue.shortfallDollars)}`);
    lines.push(plan.issue.reason);
    lines.push("");

    for (const opt of plan.options) {
      lines.push(...optionBlock(opt, opt.optionId === plan.recommendedOptionId));
      lines.push("");
    }

    lines.push("----");
    lines.push("");
  }

  appendContextBlock(lines, contextText);
  return { subject, text: lines.join("\n").trim() + "\n" };
}

export function composeTestReply(opts?: { contextText?: string }): { subject: string; text: string } {
  const lines: string[] = [
    "✅ Fixit is running.",
    "Examples:",
    "- Groceries is short $80",
    "- I moved $50 from Groceries to Dining",
    'Reply with “APPLY A” (or B/C) after Fixit suggests options.',
  ];
  appendContextBlock(lines, opts?.contextText);
  return { subject: "Fixit: running", text: lines.join("\n").trim() + "\n" };
}

export function composeGenericFixReply(opts?: { extraPromptLine?: string; contextText?: string }): { subject: string; text: string } {
  const lines: string[] = [];
  lines.push("Fix what? Tell me the envelope and what changed.");
  if (opts?.extraPromptLine) lines.push(opts.extraPromptLine);
  lines.push("Examples:");
  lines.push("- Groceries is short $80");
  lines.push("- I moved $50 from Groceries to Dining");
  lines.push("- Rent is due soon and looks short");
  appendContextBlock(lines, opts?.contextText);
  return { subject: "Fixit: what should I fix?", text: lines.join("\n").trim() + "\n" };
}

export function composeHelpReply(opts?: { contextText?: string }): { subject: string; text: string } {
  const lines: string[] = [];
  lines.push("Here’s what I can do via email:");
  lines.push("Examples:");
  lines.push("- Groceries is short $80");
  lines.push("- I moved $50 from Groceries to Dining");
  lines.push("- Rent is due soon and looks short");
  appendContextBlock(lines, opts?.contextText);
  return { subject: "Fixit: how to use", text: lines.join("\n").trim() + "\n" };
}

export function composeScopedFixitReply(opts: {
  decisionToken: string;
  primary: FixPlan;
  related?: FixPlan;
  phase: Phase;
  protectedClarify?: { envelopeName: string; allowHint: "ALLOW: protected" | "ALLOW: SafetyNet" };
  alsoNoticedLine?: string;
  contextText?: string;
}): { subject: string; text: string } {
  const { decisionToken, primary, related, phase, contextText } = opts;
  const subject = "Fixit: options to resolve";
  const lines: string[] = [];

  lines.push(introLine(phase));
  lines.push("");
  lines.push(`Decision token: ${decisionToken}`);
  lines.push(`To apply: reply with APPLY A (or B/C). Optional: APPLY A ${decisionToken}`);
  lines.push("");

  // Primary issue block (ranked options: recommended first).
  lines.push(`Primary: ${primary.issue.envelopeName}`);
  lines.push(primary.issue.reason);
  lines.push("");
  for (const opt of orderedOptions(primary)) {
    lines.push(...optionBlock(opt, opt.optionId === primary.recommendedOptionId));
    lines.push("");
  }

  // Optional short related section (only when caller provided it).
  if (related) {
    const rec = related.options.find((o) => o.optionId === related.recommendedOptionId) ?? related.options[0];
    if (rec) {
      lines.push(`Related: ${related.issue.envelopeName} — ${rec.vocabulary}: ${rec.summary}`);
      lines.push("");
    }
  }

  if (opts.protectedClarify) {
    lines.push(
      `Quick check: option ${primary.recommendedOptionId} would touch protected envelope “${opts.protectedClarify.envelopeName}”. Reply ${opts.protectedClarify.allowHint} to allow it, or tell me a different envelope to use.`
    );
    lines.push("");
  }

  if (opts.alsoNoticedLine) {
    lines.push(`Also noticed: ${opts.alsoNoticedLine}`);
    lines.push("");
  }

  appendContextBlock(lines, contextText);
  return { subject, text: lines.join("\n").trim() + "\n" };
}

export function composeApplyConfirmation(opts: {
  chosen: "A" | "B" | "C";
  decisionToken: string;
  summaryLines: string[];
  contextText?: string;
}) {
  const lines: string[] = [];
  lines.push(`Applied option ${opts.chosen} for decision token ${opts.decisionToken}.`);
  lines.push("");
  for (const l of opts.summaryLines) lines.push(l);
  appendContextBlock(lines, opts.contextText);
  return { subject: `Fixit applied: ${opts.chosen}`, text: lines.join("\n") + "\n" };
}

export function composeTransferClarifyReply(opts: {
  amountDollars?: number;
  fromEnvelope?: string;
  toEnvelope?: string;
  suggestions?: string[];
  contextText?: string;
}): { subject: string; text: string } {
  const lines: string[] = [];
  const bits: string[] = [];
  if (typeof opts.amountDollars === "number" && opts.amountDollars > 0) {
    bits.push(formatUSD(opts.amountDollars));
  }
  if (opts.fromEnvelope) bits.push(`from ${opts.fromEnvelope}`);
  if (opts.toEnvelope) bits.push(`to ${opts.toEnvelope}`);
  if (bits.length > 0) {
    lines.push(`I saw a transfer (${bits.join(" ")}).`);
  }

  lines.push("Which envelope did it come from and go to?");
  lines.push("Example: I moved $80 from Groceries to Education");
  if (opts.suggestions && opts.suggestions.length > 0) {
    lines.push("Closest matches:");
    for (const s of opts.suggestions.slice(0, 5)) lines.push(`- ${s}`);
  }
  appendContextBlock(lines, opts.contextText);
  return { subject: "Fixit: clarify transfer", text: lines.join("\n").trim() + "\n" };
}


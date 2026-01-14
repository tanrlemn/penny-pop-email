import { canBorrowFromDonor, groupRank } from "../envelopes/policy";
import { DetectedIssue, EnvelopeRule, EnvelopeState, FixPlan, FixPlanOption, PlanStep, PriorityGroup } from "../envelopes/types";

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function clampInt(n: number, min: number, max: number) {
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function usd(n: number) {
  return `$${n.toFixed(2)}`;
}

function isDiscretionaryLike(g: PriorityGroup) {
  return g === "Discretionary" || g === "Pressing";
}

function isProtectedAllowed(opts: {
  donor: EnvelopeState;
  allowSafetyNet?: boolean;
  allowProtectedReduction?: boolean;
}): boolean {
  if (!opts.donor.protected) return true;
  if (opts.allowProtectedReduction) return true;
  if (opts.allowSafetyNet && opts.donor.name === "Safety Net") return true;
  return false;
}

function pickRoutingDonor(states: EnvelopeState[], exclude: Set<string>): EnvelopeState | null {
  const candidates = states
    .filter((s) => s.balanceDollars != null && !exclude.has(s.name))
    .sort((a, b) => groupRank(a.priorityGroup) - groupRank(b.priorityGroup));
  return candidates[0] ?? null;
}

export function generateTransferPlans(opts: {
  amountDollars: number;
  fromEnvelope: string;
  toEnvelope: string;
  states: EnvelopeState[];
  rules: EnvelopeRule[];
  allowSafetyNet?: boolean;
  allowProtectedReduction?: boolean;
  routingDeposits: number;
  depositAmountAssumptionDollars: number;
}): FixPlan[] {
  const amount = Math.max(0, round2(opts.amountDollars));
  const exclude = new Set([opts.fromEnvelope, opts.toEnvelope]);
  const byName = new Map(opts.states.map((s) => [s.name, s]));
  const ruleByName = new Map(opts.rules.map((r) => [r.name, r]));
  const catchAllName = process.env.ROUTING_CATCH_ALL_POD ?? "Move to ___";
  const catchAllState = byName.get(catchAllName) ?? null;
  const catchAllAvailable = Boolean(catchAllState) || ruleByName.has(catchAllName);

  const issue: DetectedIssue = {
    type: "structural_underfund",
    envelopeName: `${opts.fromEnvelope} → ${opts.toEnvelope}`,
    severity: "info",
    shortfallDollars: amount,
    reason: `Transfer noted: moved ${usd(amount)} from ${opts.fromEnvelope} to ${opts.toEnvelope}.`,
  };

  const donorsSorted = opts.states
    .slice()
    .sort((a, b) => groupRank(a.priorityGroup) - groupRank(b.priorityGroup));

  // Option A: RESTORE donor now (manual transfers)
  const transferSteps: PlanStep[] = [];
  let remaining = amount;
  const donorUsed: string[] = [];

  for (const donor of donorsSorted) {
    if (remaining <= 0) break;
    if (exclude.has(donor.name)) continue;

    const eligibility = canBorrowFromDonor({
      donor,
      allowSafetyNet: opts.allowSafetyNet,
      allowProtectedReduction: opts.allowProtectedReduction,
    });
    if (!eligibility.ok) continue;

    const avail = donor.availableToSpendDollars ?? 0;
    const take = Math.min(avail, remaining);
    if (take <= 0) continue;

    transferSteps.push({
      kind: "transfer",
      fromEnvelope: donor.name,
      toEnvelope: opts.fromEnvelope,
      amountDollars: round2(take),
    });
    donorUsed.push(donor.name);
    remaining = round2(remaining - take);
    if (transferSteps.length >= 3) break;
  }

  const optionAWarnings: string[] = [];
  if (remaining > 0) {
    optionAWarnings.push(`Only found ${usd(amount - remaining)} of surplus above floors without touching locked envelopes.`);
  }

  const optionA: FixPlanOption = {
    optionId: "A",
    label: "Restore donor now (manual transfers)",
    vocabulary: "RESTORE",
    summary:
      transferSteps.length === 0
        ? `No safe donors available to restore ${usd(amount)} into ${opts.fromEnvelope} right now.`
        : `Move ${usd(amount - remaining)} into ${opts.fromEnvelope} now from: ${donorUsed.join(", ")}.`,
    steps: transferSteps,
    ...(optionAWarnings.length ? { warnings: optionAWarnings } : {}),
  };

  // Option B: ROUTING (next deposits)
  const deposits = clampInt(opts.routingDeposits, 1, 12);
  const assumedDeposit = Math.max(0.01, opts.depositAmountAssumptionDollars);
  const perDeposit = round2(amount / deposits);
  const deltaBps = clampInt(Math.round((perDeposit / assumedDeposit) * 10000), -10000, 10000);

  let routingDonorName: string | null = null;
  let routingDonorState: EnvelopeState | null = null;
  let blockedProtectedDonorName: string | null = null;

  if (catchAllAvailable) {
    routingDonorName = catchAllName;
    routingDonorState = catchAllState;
  } else {
    const candidate =
      donorsSorted.find((d) => isDiscretionaryLike(d.priorityGroup) && !exclude.has(d.name)) ??
      pickRoutingDonor(opts.states, exclude);
    if (candidate) {
      if (isProtectedAllowed({ donor: candidate, ...opts })) {
        routingDonorName = candidate.name;
        routingDonorState = candidate;
      } else {
        blockedProtectedDonorName = candidate.name;
      }
    }
  }

  const routingSteps: PlanStep[] = [
    { kind: "routing_override", envelope: opts.fromEnvelope, deltaBps: Math.max(0, deltaBps), remainingDeposits: deposits },
  ];

  const recipient = byName.get(opts.toEnvelope);
  const recipientShortfall =
    recipient &&
    recipient.balanceDollars != null &&
    recipient.requiredByDueDollars != null &&
    recipient.balanceDollars < recipient.requiredByDueDollars
      ? round2(recipient.requiredByDueDollars - recipient.balanceDollars)
      : 0;
  const recipientDeltaBps =
    recipientShortfall > 0
      ? clampInt(Math.round(((recipientShortfall / deposits) / assumedDeposit) * 10000), -10000, 10000)
      : 0;

  if (recipientDeltaBps > 0 && opts.toEnvelope !== opts.fromEnvelope) {
    routingSteps.push({
      kind: "routing_override",
      envelope: opts.toEnvelope,
      deltaBps: Math.max(0, recipientDeltaBps),
      remainingDeposits: deposits,
    });
  }

  const optionBWarnings: string[] = [];
  optionBWarnings.push(`Routing uses a deposit-size estimate of ${usd(assumedDeposit)}; actual dollars may differ per deposit.`);
  if (routingDonorState?.protected === true && !isProtectedAllowed({ donor: routingDonorState, ...opts })) {
    optionBWarnings.push(
      `Routing donor ${routingDonorState.name} is protected; reply ALLOW to use it or pick another envelope.`
    );
  }
  if (blockedProtectedDonorName) {
    optionBWarnings.push(
      `Routing donor ${blockedProtectedDonorName} is protected; reply ALLOW to use it or pick another envelope.`
    );
  }
  if (!routingDonorName && deltaBps !== 0) {
    optionBWarnings.push("No donor envelope found to offset the routing change; consider a manual transfer instead.");
  }

  const totalDelta = Math.max(0, deltaBps) + Math.max(0, recipientDeltaBps);
  if (routingDonorName && routingDonorName !== opts.fromEnvelope && totalDelta !== 0) {
    routingSteps.push({
      kind: "routing_override",
      envelope: routingDonorName,
      deltaBps: -Math.max(0, totalDelta),
      remainingDeposits: deposits,
    });
  }

  const approxDollars = round2((assumedDeposit * deltaBps) / 10000);
  const routingSummary =
    blockedProtectedDonorName && !routingDonorName && deltaBps !== 0
      ? `Routing needs a donor. Reply ALLOW to use ${blockedProtectedDonorName}, or tell me a different envelope.`
      : deltaBps === 0
        ? `Needed amount is too small relative to the deposit estimate to express cleanly in bps.`
        : `For next ${deposits} deposits: +${deltaBps} bps to ${opts.fromEnvelope} (≈${usd(approxDollars)}/deposit).`;
  const optionB: FixPlanOption = {
    optionId: "B",
    label: `Update next ${deposits} deposit(s) (auto routing)`,
    vocabulary: "ROUTING",
    summary: routingSummary,
    steps: routingSteps,
    warnings: optionBWarnings,
  };

  // Option C: STRUCTURAL (recipient rule adjustment)
  const recipientRule = ruleByName.get(opts.toEnvelope);
  const structuralSteps: PlanStep[] = [];
  let structuralSummary = "";

  if (recipientRule?.dueByDay) {
    const dueAmount = recipientRule.dueAmountDollars ?? recipientRule.monthlyBudgetDollars;
    const suggestedDueAmount = round2(dueAmount + amount);
    structuralSteps.push({
      kind: "rule_change",
      envelope: opts.toEnvelope,
      changes: { dueAmountDollars: suggestedDueAmount },
    });
    structuralSummary = `Increase ${opts.toEnvelope} due_amount to ${usd(suggestedDueAmount)} to absorb recurring transfers.`;
  } else if (recipientRule) {
    const suggestedMonthly = round2(recipientRule.monthlyBudgetDollars + amount);
    structuralSteps.push({
      kind: "rule_change",
      envelope: opts.toEnvelope,
      changes: { monthlyBudgetDollars: suggestedMonthly },
    });
    structuralSummary = `If this ${usd(amount)} happens every month, increase ${opts.toEnvelope} monthly_budget to ${usd(
      suggestedMonthly
    )}. Otherwise keep budget and use Restore/Routing.`;
  } else {
    structuralSummary = `Update ${opts.toEnvelope} rule so recurring transfers don’t create surprise shortfalls.`;
  }

  const optionC: FixPlanOption = {
    optionId: "C",
    label: "Make it structural (change the rule)",
    vocabulary: "STRUCTURAL",
    summary: structuralSummary,
    steps: structuralSteps,
    warnings: ["This changes the rule definition; apply only if the underlying budget target is truly wrong."],
  };

  const recommendedOptionId: "A" | "B" | "C" =
    optionA.steps.length > 0 && remaining <= 0 ? "A" : deltaBps !== 0 ? "B" : "C";

  return [
    {
      issue,
      options: [optionA, optionB, optionC],
      recommendedOptionId,
    },
  ];
}

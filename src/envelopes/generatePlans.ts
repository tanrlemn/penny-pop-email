import { canBorrowFromDonor, groupRank } from "./policy";
import { DetectedIssue, EnvelopeState, FixPlan, FixPlanOption, PlanStep, PriorityGroup } from "./types";

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function clampInt(n: number, min: number, max: number) {
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function usd(n: number) {
  return `$${n.toFixed(2)}`;
}

function pickRoutingDonor(states: EnvelopeState[]): EnvelopeState | null {
  // Prefer a single discretionary-like envelope as the offset.
  const candidates = states
    .filter((s) => s.balanceDollars != null)
    .sort((a, b) => groupRank(a.priorityGroup) - groupRank(b.priorityGroup));

  return candidates[0] ?? null;
}

function isDiscretionaryLike(g: PriorityGroup) {
  return g === "Discretionary" || g === "Pressing";
}

export function generatePlans(opts: {
  issues: DetectedIssue[];
  states: EnvelopeState[];
  scopeEnvelopeNames?: string[];
  allowSafetyNet?: boolean;
  allowProtectedReduction?: boolean;
  dueSoonWindowDays: number;
  depositAmountAssumptionDollars: number;
  routingDeposits: number;
}): FixPlan[] {
  const {
    issues: issues0,
    states,
    scopeEnvelopeNames,
    allowSafetyNet = false,
    allowProtectedReduction = false,
    depositAmountAssumptionDollars,
    routingDeposits,
  } = opts;

  // Scope behavior:
  // - Filter issues to the requested envelope set.
  // - Donors remain unrestricted (plans may borrow from any safe donor); the caller controls what issues are discussed.
  const issues = (() => {
    if (!scopeEnvelopeNames || scopeEnvelopeNames.length === 0) return issues0;
    const scope = new Set(scopeEnvelopeNames);
    return issues0.filter((i) => scope.has(i.envelopeName));
  })();

  const byName = new Map(states.map((s) => [s.name, s]));

  const donorsSorted = states
    .slice()
    .sort((a, b) => groupRank(a.priorityGroup) - groupRank(b.priorityGroup));

  const plans: FixPlan[] = [];

  for (const issue of issues) {
    const target = byName.get(issue.envelopeName);
    if (!target) continue;

    const needed = Math.max(0, round2(issue.shortfallDollars));

    // Option A: RESTORE (manual transfers now)
    const transferSteps: PlanStep[] = [];
    let remaining = needed;
    const donorUsed: string[] = [];

    for (const donor of donorsSorted) {
      if (remaining <= 0) break;
      if (donor.name === target.name) continue;

      const eligibility = canBorrowFromDonor({ donor, allowSafetyNet, allowProtectedReduction });
      if (!eligibility.ok) continue;

      const avail = donor.availableToSpendDollars ?? 0;
      const take = Math.min(avail, remaining);
      if (take <= 0) continue;

      transferSteps.push({
        kind: "transfer",
        fromEnvelope: donor.name,
        toEnvelope: target.name,
        amountDollars: round2(take),
      });
      donorUsed.push(donor.name);
      remaining = round2(remaining - take);
      if (transferSteps.length >= 3) break;
    }

    const optionAWarnings: string[] = [];
    if (remaining > 0) {
      optionAWarnings.push(
        `Only found ${usd(needed - remaining)} of surplus above floors without touching locked envelopes.`
      );
    }

    const optionA: FixPlanOption = {
      optionId: "A",
      label: "Restore now (manual transfers)",
      vocabulary: "RESTORE",
      summary:
        transferSteps.length === 0
          ? `No safe donors available to restore ${usd(needed)} right now.`
          : `Move ${usd(needed - remaining)} into ${target.name} now from: ${donorUsed.join(", ")}.`,
      steps: transferSteps,
      ...(optionAWarnings.length ? { warnings: optionAWarnings } : {}),
    };

    // Option B: ROUTING (next deposits)
    const deposits = clampInt(routingDeposits, 1, 12);
    const assumedDeposit = Math.max(0.01, depositAmountAssumptionDollars);
    const perDeposit = round2(needed / deposits);
    const deltaBps = clampInt(Math.round((perDeposit / assumedDeposit) * 10000), -10000, 10000);

    const routingDonor =
      donorsSorted.find((d) => isDiscretionaryLike(d.priorityGroup) && d.name !== target.name) ??
      pickRoutingDonor(states);

    const routingSteps: PlanStep[] = [
      { kind: "routing_override", envelope: target.name, deltaBps: Math.max(0, deltaBps), remainingDeposits: deposits },
    ];

    if (routingDonor && routingDonor.name !== target.name && deltaBps !== 0) {
      routingSteps.push({
        kind: "routing_override",
        envelope: routingDonor.name,
        deltaBps: -Math.max(0, deltaBps),
        remainingDeposits: deposits,
      });
    }

    const optionBWarnings: string[] = [];
    optionBWarnings.push(
      `Routing uses a deposit-size estimate of ${usd(assumedDeposit)}; actual dollars may differ per deposit.`
    );
    if (routingDonor?.protected === true && !allowProtectedReduction) {
      optionBWarnings.push(`Routing donor ${routingDonor.name} is protected; it will not be reduced unless allowed.`);
    }

    const approxDollars = round2((assumedDeposit * deltaBps) / 10000);
    const optionB: FixPlanOption = {
      optionId: "B",
      label: `Update next ${deposits} deposit(s) (auto routing)`,
      vocabulary: "ROUTING",
      summary:
        deltaBps === 0
          ? `Needed amount is too small relative to the deposit estimate to express cleanly in bps.`
          : `For next ${deposits} deposits: +${deltaBps} bps to ${target.name} (≈${usd(approxDollars)}/deposit).`,
      steps: routingSteps,
      warnings: optionBWarnings,
    };

    // Option C: STRUCTURAL (change the rule so this stops happening)
    const structuralSteps: PlanStep[] = [];
    let structuralSummary = "";

    if (issue.type === "timing_shortfall") {
      const dueAmount = target.dueAmountDollars;
      const suggestedDueAmount = round2(dueAmount + needed);
      structuralSteps.push({
        kind: "rule_change",
        envelope: target.name,
        changes: { dueAmountDollars: suggestedDueAmount },
      });
      structuralSummary = `Increase ${target.name} due_amount to ${usd(suggestedDueAmount)} so it’s funded by the due date without scrambling.`;
    } else if (issue.type === "overspend") {
      const suggestedMonthly = round2(target.monthlyBudgetDollars + needed);
      structuralSteps.push({
        kind: "rule_change",
        envelope: target.name,
        changes: { monthlyBudgetDollars: suggestedMonthly },
      });
      structuralSummary = `Increase ${target.name} monthly_budget to ${usd(suggestedMonthly)} (or reduce spending) so it stays above its buffer floor.`;
    } else {
      structuralSteps.push({
        kind: "rule_change",
        envelope: target.name,
        changes: { monthlyBudgetDollars: round2(target.monthlyBudgetDollars + needed) },
      });
      structuralSummary = `Adjust ${target.name} rule upward so this doesn’t repeat.`;
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

    plans.push({
      issue,
      options: [optionA, optionB, optionC],
      recommendedOptionId,
    });
  }

  return plans;
}


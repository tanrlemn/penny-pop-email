import { EnvelopeRule } from "../envelopes/types";
import { groupRank } from "../envelopes/policy";
import { RoutingBaseline, RoutingOverride, DepositPlan, DepositPlanLine } from "./types";

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function centsFromDollars(d: number): number {
  return Math.round(d * 100);
}

function dollarsFromCents(c: number): number {
  return round2(c / 100);
}

function clampInt(n: number, min: number, max: number) {
  return Math.min(Math.max(Math.trunc(n), min), max);
}

export function computeDepositPlan(opts: {
  depositAmountDollars: number;
  baselines: RoutingBaseline[];
  overrides: RoutingOverride[];
  envelopeRules: EnvelopeRule[];
  catchAllPodName: string;
  maxAdjustmentPerDepositDollars: number;
}): { plan: DepositPlan; bpsByPod: Record<string, number> } {
  const {
    depositAmountDollars,
    baselines,
    overrides,
    envelopeRules,
    catchAllPodName,
    maxAdjustmentPerDepositDollars,
  } = opts;

  const warnings: string[] = [];
  const depositCents = centsFromDollars(depositAmountDollars);
  if (depositCents <= 0) throw new Error("depositAmountDollars must be > 0");

  const baselineByPod = new Map<string, number>();
  for (const b of baselines) baselineByPod.set(b.podName, clampInt(b.bps, 0, 10000));

  const protectedSet = new Set(envelopeRules.filter((r) => r.protected).map((r) => r.name));
  const groupByPod = new Map(envelopeRules.map((r) => [r.name, r.priorityGroup]));

  const podNames = new Set<string>([catchAllPodName]);
  for (const b of baselines) podNames.add(b.podName);
  for (const o of overrides) podNames.add(o.podName);

  const bpsByPod = new Map<string, number>();
  for (const pod of podNames) bpsByPod.set(pod, baselineByPod.get(pod) ?? 0);

  const sortedOverrides = overrides.slice().sort((a, b) => a.createdAtISO.localeCompare(b.createdAtISO));

  // Apply overrides in stable order
  for (const o of sortedOverrides) {
    const baseline = baselineByPod.get(o.podName) ?? 0;
    const current = bpsByPod.get(o.podName) ?? baseline;
    let next = current + o.deltaBps;
    next = clampInt(next, 0, 10000);

    // Protected pods: do not reduce below baseline unless explicitly allowed on the override
    if (protectedSet.has(o.podName) && !o.allowProtectedReduction && next < baseline) {
      next = baseline;
      warnings.push(`Protected pod ${o.podName} not reduced (override blocked).`);
    }

    bpsByPod.set(o.podName, next);
  }

  // Clamp by per-deposit dollar adjustment (explainable safety rail).
  const maxAdjCents = Math.max(0, centsFromDollars(maxAdjustmentPerDepositDollars));
  if (maxAdjCents > 0) {
    for (const pod of podNames) {
      const baseline = baselineByPod.get(pod) ?? 0;
      const current = bpsByPod.get(pod) ?? baseline;
      const deltaBps = current - baseline;
      if (deltaBps === 0) continue;

      const deltaCents = Math.round((depositCents * deltaBps) / 10000);
      if (Math.abs(deltaCents) <= maxAdjCents) continue;

      const clampedDeltaCents = deltaCents > 0 ? maxAdjCents : -maxAdjCents;
      const clampedDeltaBps = clampInt(Math.round((clampedDeltaCents * 10000) / depositCents), -10000, 10000);
      let next = baseline + clampedDeltaBps;
      next = clampInt(next, 0, 10000);

      if (protectedSet.has(pod) && next < baseline) {
        next = baseline;
      }

      bpsByPod.set(pod, next);
      warnings.push(`Clamped adjustment for ${pod} to stay within max per-deposit change.`);
    }
  }

  // Normalize totals without “magic”: remainder goes to catch-all, overflow is removed deterministically.
  const sumBps = () => Array.from(bpsByPod.values()).reduce((a, b) => a + b, 0);

  let total = sumBps();
  if (total < 10000) {
    const add = 10000 - total;
    bpsByPod.set(catchAllPodName, (bpsByPod.get(catchAllPodName) ?? 0) + add);
    total = 10000;
  }

  if (total > 10000) {
    let overflow = total - 10000;

    // 1) Remove from catch-all first
    const catchAllBps = bpsByPod.get(catchAllPodName) ?? 0;
    const take = Math.min(catchAllBps, overflow);
    bpsByPod.set(catchAllPodName, catchAllBps - take);
    overflow -= take;

    // 2) Remove from lowest-priority pods next (Discretionary → ...), stable by name
    if (overflow > 0) {
      const candidates = Array.from(podNames)
        .filter((p) => p !== catchAllPodName)
        .filter((p) => !protectedSet.has(p))
        .sort((a, b) => {
          const ga = groupRank((groupByPod.get(a) as any) ?? "Other");
          const gb = groupRank((groupByPod.get(b) as any) ?? "Other");
          if (ga !== gb) return ga - gb;
          return a.localeCompare(b);
        });

      for (const p of candidates) {
        if (overflow <= 0) break;
        const cur = bpsByPod.get(p) ?? 0;
        const t = Math.min(cur, overflow);
        bpsByPod.set(p, cur - t);
        overflow -= t;
      }
    }

    if (overflow > 0) {
      warnings.push("Unable to resolve bps overflow without touching protected pods; returning best-effort plan.");
    }
  }

  // Convert to cents, with penny remainder going to catch-all to ensure exact total.
  const podList = Array.from(podNames).sort((a, b) => a.localeCompare(b));

  const linesCents: { podName: string; bps: number; cents: number }[] = [];
  for (const pod of podList) {
    const bps = clampInt(bpsByPod.get(pod) ?? 0, 0, 10000);
    // We'll compute catch-all last.
    if (pod === catchAllPodName) continue;
    const cents = Math.round((depositCents * bps) / 10000);
    linesCents.push({ podName: pod, bps, cents });
  }

  const sumOther = linesCents.reduce((a, b) => a + b.cents, 0);
  const catchAllBps = clampInt(bpsByPod.get(catchAllPodName) ?? 0, 0, 10000);
  const catchAllCents = depositCents - sumOther;
  linesCents.push({ podName: catchAllPodName, bps: catchAllBps, cents: catchAllCents });

  const lines: DepositPlanLine[] = linesCents.map((l) => ({
    podName: l.podName,
    bps: l.bps,
    amountDollars: dollarsFromCents(l.cents),
  }));

  const plan: DepositPlan = {
    depositAmountDollars: round2(depositAmountDollars),
    lines,
    catchAllPodName,
    warnings,
  };

  const bpsRecord: Record<string, number> = {};
  for (const [k, v] of bpsByPod.entries()) bpsRecord[k] = v;

  return { plan, bpsByPod: bpsRecord };
}


import { initDb } from "../storage/initDb";
import { listEnvelopeRules } from "../storage/envelopeRuleRepo";
import { tryInsertDepositEvent } from "../storage/depositEventRepo";
import { decrementOverrideDeposit, listActiveRoutingOverrides, listRoutingBaselines } from "../storage/routingRepo";
import { computeDepositPlan } from "./computeDepositPlan";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function getHeader(headers: Record<string, string | string[] | undefined>, key: string): string | null {
  const v = headers[key.toLowerCase()] ?? headers[key] ?? null;
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  return v;
}

function parseDepositAmountCents(body: any): number | null {
  const candidates = [
    body?.depositAmountInCents,
    body?.deposit_amount_in_cents,
    body?.depositAmountCents,
    body?.deposit_amount_cents,
    body?.amountInCents, // sometimes called that in docs (but ambiguous)
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return Math.round(c);
    if (typeof c === "string" && c.trim() && Number.isFinite(Number(c))) return Math.round(Number(c));
  }
  return null;
}

function parseDepositAmountCentsFromQuery(query: Record<string, any>): number | null {
  const candidates = [query.depositAmountInCents, query.deposit_amount_in_cents, query.depositAmountCents, query.amountInCents];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return Math.round(c);
    if (typeof c === "string" && c.trim() && Number.isFinite(Number(c))) return Math.round(Number(c));
  }
  return null;
}

function getIdempotencyKey(headers: Record<string, any>, body: any): string | null {
  const headerKey =
    getHeader(headers, "x-sequence-request-id") ??
    getHeader(headers, "idempotency-key") ??
    getHeader(headers, "x-request-id") ??
    getHeader(headers, "x-vercel-id");
  if (headerKey) return headerKey;

  const bodyKey = body?.eventId ?? body?.requestId ?? body?.transactionId ?? body?.runId ?? body?.id;
  if (typeof bodyKey === "string" && bodyKey.trim()) return bodyKey.trim();
  return null;
}

function centsFromDollars(d: number) {
  return Math.round(d * 100);
}

export type RemoteApiHandlerResult = { status: number; json: any };

export async function handleSequenceRemoteApi(opts: {
  method: string;
  headers: Record<string, any>;
  query: Record<string, any>;
  body: any;
}): Promise<RemoteApiHandlerResult> {
  if (opts.method !== "POST") return { status: 405, json: { error: "Method not allowed" } };

  const shared = process.env.SEQUENCE_REMOTE_API_SHARED_SECRET;
  if (shared) {
    const sig = getHeader(opts.headers, "x-sequence-signature");
    if (sig !== `Bearer ${shared}`) {
      return { status: 401, json: { error: "Unauthorized" } };
    }
  }

  await initDb();

  const podName = (opts.query.pod ?? opts.query.podName ?? opts.body?.podName ?? null) as string | null;
  if (!podName || typeof podName !== "string") {
    // This handler is intended to be used per-action with a pod query param.
    return { status: 400, json: { error: "Missing pod name (use ?pod=PodName)" } };
  }

  const depositAmountCents = parseDepositAmountCents(opts.body) ?? parseDepositAmountCentsFromQuery(opts.query);
  const depositAmountDollars =
    depositAmountCents != null ? depositAmountCents / 100 : Number(process.env.FIXIT_DEPOSIT_AMOUNT_ASSUMPTION ?? 2500);

  const catchAllPodName = process.env.ROUTING_CATCH_ALL_POD ?? "Move to ___";
  const maxAdj = Number(process.env.ROUTING_MAX_ADJUSTMENT_PER_DEPOSIT ?? 200);

  const [baselines, envelopeRules] = await Promise.all([listRoutingBaselines(), listEnvelopeRules()]);
  const overrides = await listActiveRoutingOverrides(todayISO());

  const { plan } = computeDepositPlan({
    depositAmountDollars,
    baselines,
    overrides,
    envelopeRules,
    catchAllPodName,
    maxAdjustmentPerDepositDollars: Number.isFinite(maxAdj) ? maxAdj : 200,
  });

  const line = plan.lines.find((l) => l.podName === podName);
  const amountDollars = line?.amountDollars ?? 0;
  const amountInCents = centsFromDollars(amountDollars);

  // Best-effort: decrement remainingDeposits once per deposit event, if we can identify it.
  const idempotencyKey = getIdempotencyKey(opts.headers, opts.body);
  if (idempotencyKey) {
    const inserted = await tryInsertDepositEvent({
      id: idempotencyKey,
      depositAmountDollars,
      rawRequestJson: JSON.stringify(opts.body ?? {}),
    });
    if (inserted) {
      for (const o of overrides) {
        if (o.remainingDeposits != null) {
          await decrementOverrideDeposit(o.id);
        }
      }
    }
  } else {
    // Without an idempotency key, we cannot safely decrement per deposit because this endpoint
    // may be called multiple times per deposit (one per transfer). Leave overrides unchanged.
    // This is still deterministic; overrides can be configured with expiresOn as a fallback.
  }

  return { status: 200, json: { amountInCents } };
}


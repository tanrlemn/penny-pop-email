import { fetchAccounts } from "../sequenceClient";
import { sendEmail } from "../email";
import { config } from "../config";
import { computeEnvelopeStates } from "../envelopes/computeFloors";
import { detectIssues } from "../envelopes/detectIssues";
import { generatePlans } from "../envelopes/generatePlans";
import { EnvelopeRule, EnvelopeState, FixPlan } from "../envelopes/types";
import { initDb } from "../storage/initDb";
import { listEnvelopeRules, applyRuleChanges } from "../storage/envelopeRuleRepo";
import { insertRoutingOverride } from "../storage/routingRepo";
import { upsertPodSnapshot, getPodBalancesForDate } from "../storage/podSnapshotRepo";
import {
  insertMessageLog,
  getDecisionByToken,
  getPendingDecisionForSender,
  setDecisionChosen,
} from "../storage/messageLogRepo";
import { tryMarkMessageProcessed } from "../storage/processedMessageRepo";
import { classifyFixitEmail } from "./classifyTask";
import {
  composeApplyConfirmation,
  composeGenericFixReply,
  composeHelpReply,
  composeScopedFixitReply,
  composeTestReply,
  composeTransferClarifyReply,
} from "./replyComposer";
import { generateTransferPlans } from "./transferPlans";
import { createGmailClient, fetchMessage, listUnreadFixitMessageIds, markMessageRead } from "./gmailClient";
import { parseFixitEmail } from "./parseEmail";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function getEnvNumber(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function shortToken(): string {
  // short, email-friendly token (not a secret, just a correlation id)
  return Math.random().toString(36).slice(2, 10);
}

function dueDateThisMonthISO(todayISO_: string, dueByDay: number): string {
  const d = new Date(todayISO_ + "T00:00:00Z");
  const y = d.getUTCFullYear();
  const m0 = d.getUTCMonth();
  const dim = new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
  const day = Math.min(Math.max(dueByDay, 1), dim);
  return new Date(Date.UTC(y, m0, day)).toISOString().slice(0, 10);
}

function suggestEnvelopeMatches(cleanText: string, knownEnvelopeNames: string[], limit = 5): string[] {
  const tokens = cleanText
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
  if (tokens.length === 0) return [];

  const scored = knownEnvelopeNames
    .map((name) => {
      const lower = name.toLowerCase();
      const score = tokens.reduce((acc, t) => acc + (lower.includes(t) ? 1 : 0), 0);
      return { name, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return scored.slice(0, limit).map((s) => s.name);
}

function buildReplySubject(originalSubject: string | null, fallback: string): string {
  const original = (originalSubject ?? "").trim();
  if (!original) return fallback;
  return /^re:\s*/i.test(original) ? original : `Re: ${original}`;
}

function logThreadingStatus(opts: { threadId: string | null; inReplyTo: string | null; intent: string }) {
  const usedThreadId = Boolean(opts.threadId);
  const usedInReplyTo = Boolean(opts.inReplyTo);
  console.log(
    `[fixit] reply threading for ${opts.intent}: threadId=${usedThreadId ? "yes" : "no"}, inReplyTo=${
      usedInReplyTo ? "yes" : "no"
    }`
  );
}

async function handleApply(opts: {
  fromEmail: string;
  gmailMessageId: string;
  threadId: string | null;
  bodyText: string;
  chosen: "A" | "B" | "C";
  allowProtectedReduction: boolean;
  allowSafetyNet: boolean;
  decisionToken?: string | null;
  contextText: string;
}): Promise<{ subject: string; text: string }> {
  const pending = opts.decisionToken
    ? await getDecisionByToken(opts.fromEmail, opts.decisionToken)
    : await getPendingDecisionForSender(opts.fromEmail);
  if (!pending || !pending.planJson || !pending.decisionToken) {
    return {
      subject: "Fixit apply: nothing pending",
      text: "I couldn’t find a pending Fixit decision to apply for you. If you meant to apply a specific message, reply to the latest Fixit email and resend: APPLY A (or B/C).\n",
    };
  }
  if (pending.chosenOption) {
    return {
      subject: "Fixit apply: already applied",
      text: `Decision token ${pending.decisionToken} was already applied (${pending.chosenOption}).\n`,
    };
  }

  const plans = JSON.parse(pending.planJson) as FixPlan[];
  const rules = await listEnvelopeRules();
  const byName = new Map(rules.map((r) => [r.name, r]));
  const summaryLines: string[] = [];

  for (const plan of plans) {
    const option = plan.options.find((o) => o.optionId === opts.chosen);
    if (!option) continue;
    summaryLines.push(`Issue ${plan.issue.envelopeName}: ${option.vocabulary} — ${option.summary}`);

    for (const step of option.steps) {
      if (step.kind === "routing_override") {
        const rule = byName.get(step.envelope);
        const isSafetyNet = rule?.priorityGroup === "SafetyNet";
        await insertRoutingOverride({
          podName: step.envelope,
          deltaBps: step.deltaBps,
          remainingDeposits: step.remainingDeposits,
          expiresOn: null,
          reason: `Fixit ${pending.decisionToken} (${opts.chosen})`,
          createdBy: opts.fromEmail,
          allowProtectedReduction: opts.allowProtectedReduction || (opts.allowSafetyNet && isSafetyNet),
        });
        summaryLines.push(`- Stored routing override: ${step.envelope} ${step.deltaBps >= 0 ? "+" : "-"}${Math.abs(step.deltaBps)} bps for ${step.remainingDeposits} deposit(s)`);
      } else if (step.kind === "rule_change") {
        await applyRuleChanges(step.envelope, step.changes as any);
        summaryLines.push(`- Updated rule for ${step.envelope}: ${Object.keys(step.changes).join(", ")}`);
      } else if (step.kind === "transfer") {
        summaryLines.push(`- Manual transfer: ${step.fromEnvelope} → ${step.toEnvelope} $${step.amountDollars.toFixed(2)}`);
      }
    }
  }

  await setDecisionChosen(pending.decisionToken, opts.chosen);
  return composeApplyConfirmation({
    chosen: opts.chosen,
    decisionToken: pending.decisionToken,
    summaryLines,
    contextText: opts.contextText,
  });
}

async function handleFixit(opts: {
  fromEmail: string;
  gmailMessageId: string;
  threadId: string | null;
  bodyText: string;
  allowSafetyNet: boolean;
  allowProtectedReduction: boolean;
  restoreDays?: number | null;
  phase: "DEFAULT" | "PRE_TRIP" | "ON_TRIP";
  scopeEnvelopeNames: string[];
  primaryEnvelopeName?: string;
  transferFrom?: string;
  transferTo?: string;
  contextText: string;
}): Promise<{ subject: string; text: string; decisionToken: string; plans: FixPlan[] }> {
  const accounts = await fetchAccounts();
  const rules = await listEnvelopeRules();

  const tISO = todayISO();

  // Keep daily pod balance snapshots for best-effort overdue detection.
  for (const a of accounts) {
    if (a.type !== "Pod") continue;
    if (a.balanceDollars == null) continue;
    await upsertPodSnapshot({ dateISO: tISO, podName: a.name, balanceDollars: a.balanceDollars });
  }

  const states0 = computeEnvelopeStates({ accounts, rules });

  // Build due-date snapshot lookup for any envelope whose due date already passed this month.
  const todayDay = new Date(tISO + "T00:00:00Z").getUTCDate();
  const dueDateBalances: Record<string, number | null> = {};
  const dueDatesNeeded = new Set<string>();
  for (const s of states0) {
    if (typeof s.dueByDay === "number" && s.dueByDay > 0 && todayDay > s.dueByDay) {
      dueDatesNeeded.add(dueDateThisMonthISO(tISO, s.dueByDay));
    }
  }

  const balancesByDate: Record<string, Record<string, number>> = {};
  for (const dueISO of dueDatesNeeded) {
    balancesByDate[dueISO] = await getPodBalancesForDate(dueISO);
  }
  for (const s of states0) {
    if (typeof s.dueByDay === "number" && s.dueByDay > 0 && todayDay > s.dueByDay) {
      const dueISO = dueDateThisMonthISO(tISO, s.dueByDay);
      dueDateBalances[s.name] = balancesByDate[dueISO]?.[s.name] ?? null;
    }
  }

  const dueSoonWindowDays = getEnvNumber("FIXIT_DUE_SOON_WINDOW_DAYS", 7);
  const { states, issues } = detectIssues({
    states: states0,
    todayISO: tISO,
    dueSoonWindowDays,
    dueDateSnapshotBalances: dueDateBalances,
  });

  const depositAssumption = getEnvNumber("FIXIT_DEPOSIT_AMOUNT_ASSUMPTION", 2500);
  const defaultRoutingDeposits = getEnvNumber("FIXIT_ROUTING_DEPOSITS", 2);
  const cadenceDays = getEnvNumber("FIXIT_DEPOSIT_CADENCE_DAYS", 14);
  const routingDeposits =
    typeof opts.restoreDays === "number" && opts.restoreDays > 0
      ? Math.max(1, Math.ceil(opts.restoreDays / Math.max(1, cadenceDays)))
      : defaultRoutingDeposits;

  const plans = generatePlans({
    issues,
    states,
    scopeEnvelopeNames: opts.scopeEnvelopeNames,
    allowSafetyNet: opts.allowSafetyNet,
    allowProtectedReduction: opts.allowProtectedReduction,
    dueSoonWindowDays,
    depositAmountAssumptionDollars: depositAssumption,
    routingDeposits,
  });

  const decisionToken = shortToken();
  const byEnvelope = new Map(plans.map((p) => [p.issue.envelopeName, p]));

  const primaryPlan =
    (opts.primaryEnvelopeName ? byEnvelope.get(opts.primaryEnvelopeName) : null) ??
    (opts.transferTo ? byEnvelope.get(opts.transferTo) : null) ??
    (opts.transferFrom ? byEnvelope.get(opts.transferFrom) : null) ??
    plans[0] ??
    null;

  // Optional related plan (minimal rule: include transfer.from if present and distinct from primary).
  const relatedPlan =
    primaryPlan && opts.transferFrom && opts.transferFrom !== primaryPlan.issue.envelopeName
      ? byEnvelope.get(opts.transferFrom) ?? null
      : null;

  if (!primaryPlan) {
    const target = opts.primaryEnvelopeName ?? opts.transferTo ?? opts.transferFrom ?? "that envelope";
    const lines: string[] = [];
    lines.push(`I don’t see an issue for ${target} right now.`);
    lines.push("Tell me what change you want (transfer now vs routing vs rule change), and include the envelope name.");
    const reply = { subject: "Fixit: no issue found", text: lines.join("\n").trim() + "\n" };
    return { ...reply, decisionToken, plans: [] };
  }

  const protectedClarify = findProtectedTouchForRecommended({
    plan: primaryPlan,
    rules,
    states,
    allowSafetyNet: opts.allowSafetyNet,
    allowProtectedReduction: opts.allowProtectedReduction,
  });

  const plansForDecision = relatedPlan ? [primaryPlan, relatedPlan] : [primaryPlan];

  const alsoNoticedLine = (() => {
    const enabled =
      process.env.FIXIT_INCLUDE_SEVERE_UNRELATED === "1" ||
      String(process.env.FIXIT_INCLUDE_SEVERE_UNRELATED ?? "").toLowerCase() === "true";
    if (!enabled) return null;

    const scopeLower = new Set((opts.scopeEnvelopeNames ?? []).map((n) => n.toLowerCase()));
    const ruleByName = new Map(rules.map((r) => [r.name, r]));
    const severe = issues.find((i) => {
      if (i.severity !== "error") return false;
      if (scopeLower.has(i.envelopeName.toLowerCase())) return false;
      const r = ruleByName.get(i.envelopeName);
      return Boolean(r?.protected);
    });
    if (!severe) return null;
    return `${severe.envelopeName} is overdue (protected).`;
  })();

  const reply = composeScopedFixitReply({
    decisionToken,
    primary: primaryPlan,
    ...(relatedPlan ? { related: relatedPlan } : {}),
    phase: opts.phase,
    ...(protectedClarify ? { protectedClarify } : {}),
    ...(alsoNoticedLine ? { alsoNoticedLine } : {}),
    contextText: opts.contextText,
  });

  return { ...reply, decisionToken, plans: plansForDecision };
}

async function handleTransfer(opts: {
  fromEmail: string;
  gmailMessageId: string;
  threadId: string | null;
  bodyText: string;
  amountDollars: number;
  fromEnvelope: string;
  toEnvelope: string;
  allowSafetyNet: boolean;
  allowProtectedReduction: boolean;
  restoreDays?: number | null;
  phase: "DEFAULT" | "PRE_TRIP" | "ON_TRIP";
  contextText: string;
}): Promise<{ subject: string; text: string; decisionToken: string; plans: FixPlan[] }> {
  const accounts = await fetchAccounts();
  const rules = await listEnvelopeRules();
  const states = computeEnvelopeStates({ accounts, rules });

  const depositAssumption = getEnvNumber("FIXIT_DEPOSIT_AMOUNT_ASSUMPTION", 2500);
  const defaultRoutingDeposits = getEnvNumber("FIXIT_ROUTING_DEPOSITS", 2);
  const cadenceDays = getEnvNumber("FIXIT_DEPOSIT_CADENCE_DAYS", 14);
  const routingDeposits =
    typeof opts.restoreDays === "number" && opts.restoreDays > 0
      ? Math.max(1, Math.ceil(opts.restoreDays / Math.max(1, cadenceDays)))
      : defaultRoutingDeposits;

  const plans = generateTransferPlans({
    amountDollars: opts.amountDollars,
    fromEnvelope: opts.fromEnvelope,
    toEnvelope: opts.toEnvelope,
    states,
    rules,
    allowSafetyNet: opts.allowSafetyNet,
    allowProtectedReduction: opts.allowProtectedReduction,
    routingDeposits,
    depositAmountAssumptionDollars: depositAssumption,
  });

  const decisionToken = shortToken();
  const primary = plans[0];
  if (!primary) {
    const reply = {
      subject: "Fixit: transfer noted",
      text: "I couldn't build transfer options from the details provided. Please include both envelope names and the amount.\n",
    };
    return { ...reply, decisionToken, plans: [] };
  }

  const protectedClarify = findProtectedTouchForRecommended({
    plan: primary,
    rules,
    states,
    allowSafetyNet: opts.allowSafetyNet,
    allowProtectedReduction: opts.allowProtectedReduction,
  });

  const reply = composeScopedFixitReply({
    decisionToken,
    primary,
    phase: opts.phase,
    ...(protectedClarify ? { protectedClarify } : {}),
    contextText: opts.contextText,
  });

  return { ...reply, decisionToken, plans };
}

function findProtectedTouchForRecommended(opts: {
  plan: FixPlan;
  rules: EnvelopeRule[];
  states: EnvelopeState[];
  allowSafetyNet: boolean;
  allowProtectedReduction: boolean;
}): { envelopeName: string; allowHint: "ALLOW: protected" | "ALLOW: SafetyNet" } | null {
  const ruleByName = new Map(opts.rules.map((r) => [r.name, r]));
  const stateByName = new Map(opts.states.map((s) => [s.name, s]));

  const recommended = opts.plan.options.find((o) => o.optionId === opts.plan.recommendedOptionId);
  if (!recommended) return null;

  const touched: string[] = [];
  for (const step of recommended.steps) {
    if (step.kind === "transfer") touched.push(step.fromEnvelope);
    if (step.kind === "routing_override" && step.deltaBps < 0) touched.push(step.envelope);
  }

  for (const name of touched) {
    const rule = ruleByName.get(name);
    const state = stateByName.get(name);
    const isProtected = Boolean(rule?.protected ?? state?.protected);
    if (!isProtected) continue;

    const isSafetyNet = rule?.priorityGroup === "SafetyNet";
    if (opts.allowProtectedReduction) continue;
    if (opts.allowSafetyNet && isSafetyNet) continue;

    return { envelopeName: name, allowHint: isSafetyNet ? "ALLOW: SafetyNet" : "ALLOW: protected" };
  }

  return null;
}

export async function pollFixitOnce(): Promise<void> {
  await initDb();

  const label = process.env.GMAIL_FIXIT_LABEL ?? "penny_pop/fixit";
  const gmail = createGmailClient();
  const ids = await listUnreadFixitMessageIds(gmail, { label, maxResults: 10 });

  const rulesForParsing = await listEnvelopeRules();
  const knownEnvelopeNames = rulesForParsing.map((r) => r.name);

  for (const id of ids) {
    const msg = await fetchMessage(gmail, id);
    const fromEmail = msg.fromEmail;
    if (!fromEmail) {
      await markMessageRead(gmail, id);
      continue;
    }

    // Idempotency gate
    const inserted = await tryMarkMessageProcessed({
      gmailMessageId: msg.id,
      threadId: msg.threadId,
      fromEmail,
      receivedAtISO: new Date().toISOString(),
    });
    if (!inserted) {
      await markMessageRead(gmail, id);
      continue;
    }

    const parsed = parseFixitEmail({ bodyText: msg.bodyText, knownEnvelopeNames });
    const task = classifyFixitEmail(parsed);

    await insertMessageLog({
      direction: "in",
      gmailMessageId: msg.id,
      threadId: msg.threadId,
      fromEmail,
      subject: msg.subject,
      bodyText: msg.bodyText,
      classification: `fixit_in:${task.intent}`,
      planJson: null,
      decisionToken: null,
      chosenOption: null,
    });

    if (task.intent === "APPLY" && task.commands.applyOption) {
      const inReplyTo = msg.rfcMessageId ?? null;
      const reply = await handleApply({
        fromEmail,
        gmailMessageId: msg.id,
        threadId: msg.threadId,
        bodyText: msg.bodyText,
        chosen: task.commands.applyOption,
        allowProtectedReduction: Boolean(task.commands.allowProtectedReduction),
        allowSafetyNet: Boolean(task.commands.allowSafetyNet),
        decisionToken: task.commands.decisionToken ?? null,
        contextText: parsed.cleanText,
      });

      const replySubject = buildReplySubject(msg.subject, reply.subject);
      await sendEmail({
        to: fromEmail,
        from: config.email.from,
        subject: replySubject,
        text: reply.text,
        threadId: msg.threadId,
        inReplyTo,
        references: msg.references ?? null,
      });
      logThreadingStatus({ threadId: msg.threadId, inReplyTo, intent: "APPLY" });
      await insertMessageLog({
        direction: "out",
        gmailMessageId: msg.id,
        threadId: msg.threadId,
        fromEmail,
        subject: replySubject,
        bodyText: reply.text,
        classification: "fixit_apply",
        planJson: null,
        decisionToken: null,
        chosenOption: task.commands.applyOption,
      });

      await markMessageRead(gmail, id);
      continue;
    }

    if (task.intent === "TEST") {
      const inReplyTo = msg.rfcMessageId ?? null;
      const reply = composeTestReply({ contextText: parsed.cleanText });
      const replySubject = buildReplySubject(msg.subject, reply.subject);
      await sendEmail({
        to: fromEmail,
        from: config.email.from,
        subject: replySubject,
        text: reply.text,
        threadId: msg.threadId,
        inReplyTo,
        references: msg.references ?? null,
      });
      logThreadingStatus({ threadId: msg.threadId, inReplyTo, intent: "TEST" });
      await insertMessageLog({
        direction: "out",
        gmailMessageId: msg.id,
        threadId: msg.threadId,
        fromEmail,
        subject: replySubject,
        bodyText: reply.text,
        classification: "fixit_test",
        planJson: null,
        decisionToken: null,
        chosenOption: null,
      });
      await markMessageRead(gmail, id);
      continue;
    }

    if (task.intent === "HELP") {
      const inReplyTo = msg.rfcMessageId ?? null;
      const reply = composeHelpReply({ contextText: parsed.cleanText });
      const replySubject = buildReplySubject(msg.subject, reply.subject);
      await sendEmail({
        to: fromEmail,
        from: config.email.from,
        subject: replySubject,
        text: reply.text,
        threadId: msg.threadId,
        inReplyTo,
        references: msg.references ?? null,
      });
      logThreadingStatus({ threadId: msg.threadId, inReplyTo, intent: "HELP" });
      await insertMessageLog({
        direction: "out",
        gmailMessageId: msg.id,
        threadId: msg.threadId,
        fromEmail,
        subject: replySubject,
        bodyText: reply.text,
        classification: "fixit_help",
        planJson: null,
        decisionToken: null,
        chosenOption: null,
      });
      await markMessageRead(gmail, id);
      continue;
    }

    if (task.intent === "TRANSFER_REQUEST") {
      const amount = task.transfer?.amount;
      const from = task.transfer?.from;
      const to = task.transfer?.to;

      if (!(typeof amount === "number" && amount > 0) || !from || !to) {
        const inReplyTo = msg.rfcMessageId ?? null;
        const suggestions = suggestEnvelopeMatches(parsed.cleanText, knownEnvelopeNames);
        const reply = composeTransferClarifyReply({
          amountDollars: typeof amount === "number" ? amount : undefined,
          fromEnvelope: from,
          toEnvelope: to,
          suggestions,
          contextText: parsed.cleanText,
        });
        const replySubject = buildReplySubject(msg.subject, reply.subject);
        await sendEmail({
          to: fromEmail,
          from: config.email.from,
          subject: replySubject,
          text: reply.text,
          threadId: msg.threadId,
          inReplyTo,
          references: msg.references ?? null,
        });
        logThreadingStatus({ threadId: msg.threadId, inReplyTo, intent: "TRANSFER_CLARIFY" });
        await insertMessageLog({
          direction: "out",
          gmailMessageId: msg.id,
          threadId: msg.threadId,
          fromEmail,
          subject: replySubject,
          bodyText: reply.text,
          classification: "fixit_transfer_clarify",
          planJson: null,
          decisionToken: null,
          chosenOption: null,
        });
        await markMessageRead(gmail, id);
        continue;
      }

      const { subject, text, decisionToken, plans } = await handleTransfer({
        fromEmail,
        gmailMessageId: msg.id,
        threadId: msg.threadId,
        bodyText: msg.bodyText,
        amountDollars: amount,
        fromEnvelope: from,
        toEnvelope: to,
        allowSafetyNet: Boolean(task.commands.allowSafetyNet),
        allowProtectedReduction: Boolean(task.commands.allowProtectedReduction),
        restoreDays: task.commands.restoreDays ?? null,
        phase: task.commands.phase ?? "DEFAULT",
        contextText: parsed.cleanText,
      });

      const replySubject = buildReplySubject(msg.subject, subject);
      const inReplyTo = msg.rfcMessageId ?? null;
      await sendEmail({
        to: fromEmail,
        from: config.email.from,
        subject: replySubject,
        text,
        threadId: msg.threadId,
        inReplyTo,
        references: msg.references ?? null,
      });
      logThreadingStatus({ threadId: msg.threadId, inReplyTo, intent: "TRANSFER_REPLY" });
      await insertMessageLog({
        direction: "out",
        gmailMessageId: msg.id,
        threadId: msg.threadId,
        fromEmail,
        subject: replySubject,
        bodyText: text,
        classification: "fixit_transfer_reply",
        planJson: plans.length > 0 ? JSON.stringify(plans) : null,
        decisionToken: plans.length > 0 ? decisionToken : null,
        chosenOption: null,
      });
      await markMessageRead(gmail, id);
      continue;
    }

    if (task.intent === "GENERIC_FIX") {
      const extra =
        task.reason.toLowerCase().includes("amount")
          ? "I see an amount — which envelope did it come from and go to?"
          : undefined;
      const inReplyTo = msg.rfcMessageId ?? null;
      const reply = composeGenericFixReply({ ...(extra ? { extraPromptLine: extra } : {}), contextText: parsed.cleanText });
      const replySubject = buildReplySubject(msg.subject, reply.subject);
      await sendEmail({
        to: fromEmail,
        from: config.email.from,
        subject: replySubject,
        text: reply.text,
        threadId: msg.threadId,
        inReplyTo,
        references: msg.references ?? null,
      });
      logThreadingStatus({ threadId: msg.threadId, inReplyTo, intent: "GENERIC_FIX" });
      await insertMessageLog({
        direction: "out",
        gmailMessageId: msg.id,
        threadId: msg.threadId,
        fromEmail,
        subject: replySubject,
        bodyText: reply.text,
        classification: "fixit_generic",
        planJson: null,
        decisionToken: null,
        chosenOption: null,
      });
      await markMessageRead(gmail, id);
      continue;
    }

    // SPECIFIC_FIX: run deterministic core but scoped.
    const { subject, text, decisionToken, plans } = await handleFixit({
      fromEmail,
      gmailMessageId: msg.id,
      threadId: msg.threadId,
      bodyText: msg.bodyText,
      allowSafetyNet: Boolean(task.commands.allowSafetyNet),
      allowProtectedReduction: Boolean(task.commands.allowProtectedReduction),
      restoreDays: task.commands.restoreDays ?? null,
      phase: task.commands.phase ?? "DEFAULT",
      scopeEnvelopeNames: task.scopeEnvelopeNames,
      primaryEnvelopeName: task.primaryEnvelopeName,
      transferFrom: task.transfer?.from,
      transferTo: task.transfer?.to,
      contextText: parsed.cleanText,
    });

    const replySubject = buildReplySubject(msg.subject, subject);
    const inReplyTo = msg.rfcMessageId ?? null;
    await sendEmail({
      to: fromEmail,
      from: config.email.from,
      subject: replySubject,
      text,
      threadId: msg.threadId,
      inReplyTo,
      references: msg.references ?? null,
    });
    logThreadingStatus({ threadId: msg.threadId, inReplyTo, intent: "SPECIFIC_FIX" });

    await insertMessageLog({
      direction: "out",
      gmailMessageId: msg.id,
      threadId: msg.threadId,
      fromEmail,
      subject: replySubject,
      bodyText: text,
      classification: "fixit_scoped_reply",
      planJson: plans.length > 0 ? JSON.stringify(plans) : null,
      decisionToken: plans.length > 0 ? decisionToken : null,
      chosenOption: null,
    });

    await markMessageRead(gmail, id);
  }
}


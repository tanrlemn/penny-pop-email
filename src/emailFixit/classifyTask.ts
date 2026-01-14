import { ParsedEmailCommands, ParsedFixitEmail, TransferHint } from "./parseEmail";

export type FixitIntent = "TEST" | "SPECIFIC_FIX" | "GENERIC_FIX" | "TRANSFER_REQUEST" | "HELP" | "APPLY";

export interface FixitEmailTask {
  intent: FixitIntent;
  reason: string;
  confidence: number; // 0..1

  commands: ParsedEmailCommands;
  cleanText: string;
  mentionedEnvelopes: string[];
  transfer?: TransferHint;

  scopeEnvelopeNames: string[];
  primaryEnvelopeName?: string;
}

function uniqStable(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of items) {
    const v = String(x || "").trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function pickPrimaryEnvelopeName(parsed: ParsedFixitEmail): string | undefined {
  if (parsed.transfer?.to) return parsed.transfer.to;
  if (parsed.mentionedEnvelopes.length === 1) return parsed.mentionedEnvelopes[0];
  if (parsed.transfer?.from) return parsed.transfer.from;
  return parsed.mentionedEnvelopes[0];
}

export function classifyFixitEmail(parsed: ParsedFixitEmail): FixitEmailTask {
  const t = parsed.cleanTextLower.trim();

  // APPLY wins (must work even if the message otherwise looks like TEST/GENERIC/HELP).
  if (parsed.commands.applyOption) {
    return {
      intent: "APPLY",
      reason: "Explicit APPLY token",
      confidence: 1,
      commands: parsed.commands,
      cleanText: parsed.cleanText,
      mentionedEnvelopes: parsed.mentionedEnvelopes,
      ...(parsed.transfer ? { transfer: parsed.transfer } : {}),
      scopeEnvelopeNames: uniqStable([parsed.transfer?.from ?? "", parsed.transfer?.to ?? "", ...parsed.mentionedEnvelopes]),
      primaryEnvelopeName: pickPrimaryEnvelopeName(parsed),
    };
  }

  const hasAmount = typeof parsed.transfer?.amount === "number" && parsed.transfer.amount > 0;
  const hasMentions = parsed.mentionedEnvelopes.length > 0;
  const hasFromTo = Boolean(parsed.transfer?.from && parsed.transfer?.to);

  const hasTransferVerb = /\b(moved|move|transfer|transferred|borrow|borrowed)\b/.test(t);
  const hasTiming = /\b(short|timing|due|overdue|past\s+due|late)\b/.test(t);

  const hasFixPhrase = /\b(fix\s+it|fix\s+this|help\s+me\s+fix|can\s+you\s+fix|please\s+fix|resolve\s+this)\b/.test(t);
  const isHelpish =
    /\b(help|commands|what\s+can\s+you\s+do|how\s+do\s+i)\b/.test(t) || t.includes("?");
  const isVeryShort = t.length > 0 && t.length < 6;

  const scopeEnvelopeNames = uniqStable([parsed.transfer?.from ?? "", parsed.transfer?.to ?? "", ...parsed.mentionedEnvelopes]);

  const hasTransferEndpoints = Boolean(parsed.transfer?.from || parsed.transfer?.to);
  if (hasAmount && hasTransferEndpoints && hasTransferVerb) {
    return {
      intent: "TRANSFER_REQUEST",
      reason: "Transfer wording with amount + endpoints",
      confidence: 0.9,
      commands: parsed.commands,
      cleanText: parsed.cleanText,
      mentionedEnvelopes: parsed.mentionedEnvelopes,
      ...(parsed.transfer ? { transfer: parsed.transfer } : {}),
      scopeEnvelopeNames,
      primaryEnvelopeName: pickPrimaryEnvelopeName(parsed),
    };
  }

  // TEST
  if (t === "test" || t === "ping") {
    return {
      intent: "TEST",
      reason: "Exact ping",
      confidence: 1,
      commands: parsed.commands,
      cleanText: parsed.cleanText,
      mentionedEnvelopes: parsed.mentionedEnvelopes,
      ...(parsed.transfer ? { transfer: parsed.transfer } : {}),
      scopeEnvelopeNames: [],
    };
  }

  // SPECIFIC (guard: amount alone is not enough).
  const isSpecific =
    (hasAmount && (hasMentions || hasFromTo || hasTiming)) || (hasFromTo && hasTransferVerb) || (hasMentions && hasTiming);
  if (isSpecific && scopeEnvelopeNames.length > 0) {
    return {
      intent: "SPECIFIC_FIX",
      reason: "Anchored request (amount/from→to/timing + envelope)",
      confidence: 0.8,
      commands: parsed.commands,
      cleanText: parsed.cleanText,
      mentionedEnvelopes: parsed.mentionedEnvelopes,
      ...(parsed.transfer ? { transfer: parsed.transfer } : {}),
      scopeEnvelopeNames,
      primaryEnvelopeName: pickPrimaryEnvelopeName(parsed),
    };
  }

  // GENERIC: fix-ish but unanchored (or amount-only without envelopes).
  if ((!hasMentions && !hasFromTo && (hasFixPhrase || t.length === 0)) || (hasAmount && !hasMentions && !hasFromTo && !hasTiming)) {
    return {
      intent: "GENERIC_FIX",
      reason: hasAmount ? "Amount mentioned but no envelopes/from→to" : "Fix request without actionable anchors",
      confidence: 0.7,
      commands: parsed.commands,
      cleanText: parsed.cleanText,
      mentionedEnvelopes: parsed.mentionedEnvelopes,
      ...(parsed.transfer ? { transfer: parsed.transfer } : {}),
      scopeEnvelopeNames: [],
    };
  }

  // HELP-ish: explicit help, very short, or unknown.
  if (isHelpish || isVeryShort) {
    return {
      intent: "HELP",
      reason: isHelpish ? "Help/usage request" : "Very short/ambiguous message",
      confidence: 0.7,
      commands: parsed.commands,
      cleanText: parsed.cleanText,
      mentionedEnvelopes: parsed.mentionedEnvelopes,
      ...(parsed.transfer ? { transfer: parsed.transfer } : {}),
      scopeEnvelopeNames: [],
    };
  }

  // Default: unknowns become HELP-ish.
  return {
    intent: "HELP",
    reason: "Unrecognized; showing usage",
    confidence: 0.5,
    commands: parsed.commands,
    cleanText: parsed.cleanText,
    mentionedEnvelopes: parsed.mentionedEnvelopes,
    ...(parsed.transfer ? { transfer: parsed.transfer } : {}),
    scopeEnvelopeNames: [],
  };
}


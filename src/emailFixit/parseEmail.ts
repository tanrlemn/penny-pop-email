import { EnvelopeRule } from "../envelopes/types";

export type Phase = "DEFAULT" | "PRE_TRIP" | "ON_TRIP";

export interface ParsedEmailCommands {
  applyOption?: "A" | "B" | "C";
  decisionToken?: string | null;
  allowSafetyNet?: boolean;
  allowProtectedReduction?: boolean;
  restoreDays?: number | null;
  phase?: Phase;
}

export interface TransferHint {
  amount?: number;
  from?: string;
  to?: string;
}

export interface ParsedFixitEmail {
  /**
   * Cleaned newest-message text only (quoted history removed).
   * This is the text used for intent classification and token parsing.
   */
  cleanText: string;
  cleanTextLower: string;
  commands: ParsedEmailCommands;
  mentionedEnvelopes: string[];
  transfer?: TransferHint;
}

export interface EnvelopeMatchEntry {
  canonicalName: string;
  normalizedMatch: string;
}

export interface EnvelopeMatchIndex {
  entries: EnvelopeMatchEntry[];
  normalizedByCanonical: Map<string, string[]>;
}

function parseApply(line: string): { option?: "A" | "B" | "C"; token?: string | null } | null {
  const m = line.trim().match(/^APPLY\s+([ABC])(?:\s+([A-Za-z0-9_-]{6,}))?$/i);
  if (!m) return null;
  const option = m[1].toUpperCase() as "A" | "B" | "C";
  const token = m[2] ? String(m[2]) : null;
  return { option, token };
}

function parseKeyValue(line: string): { key: string; value: string } | null {
  const m = line.match(/^([A-Z_]+)\s*:\s*(.+)$/);
  if (!m) return null;
  return { key: m[1].trim().toUpperCase(), value: m[2].trim() };
}

export function parseEmailCommands(bodyText: string): ParsedEmailCommands {
  const lines = bodyText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const out: ParsedEmailCommands = { phase: "DEFAULT" };

  for (const line of lines.slice(0, 25)) {
    const apply = parseApply(line);
    if (apply) {
      out.applyOption = apply.option;
      out.decisionToken = apply.token ?? null;
      continue;
    }

    const kv = parseKeyValue(line);
    if (!kv) continue;

    if (kv.key === "PHASE") {
      const v = kv.value.toUpperCase();
      out.phase = v === "ON_TRIP" ? "ON_TRIP" : v === "PRE_TRIP" ? "PRE_TRIP" : "DEFAULT";
      continue;
    }

    if (kv.key === "ALLOW") {
      const v = kv.value.toLowerCase();
      if (v.includes("safety") || v.includes("safetynet")) out.allowSafetyNet = true;
      if (v.includes("protected")) out.allowProtectedReduction = true;
      continue;
    }

    if (kv.key === "RESTORE") {
      const m = kv.value.match(/(\d+)/);
      if (m) out.restoreDays = Number(m[1]);
      continue;
    }

    if (kv.key === "TOKEN") {
      out.decisionToken = kv.value;
      continue;
    }
  }

  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeEnvelopeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/["']/g, "")
    .replace(/_+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildNormalizedMatches(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const normalized = normalizeEnvelopeText(v ?? "");
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function buildEnvelopeMatchIndex(rules: EnvelopeRule[]): EnvelopeMatchIndex {
  const entries: EnvelopeMatchEntry[] = [];
  const normalizedByCanonical = new Map<string, string[]>();

  for (const rule of rules) {
    const matches = buildNormalizedMatches([rule.name, ...(rule.aliases ?? [])]);
    if (matches.length === 0) continue;
    normalizedByCanonical.set(rule.name, matches);
    for (const normalizedMatch of matches) {
      entries.push({ canonicalName: rule.name, normalizedMatch });
    }
  }

  return { entries, normalizedByCanonical };
}

function isOutlookHeaderBlockStart(lineTrimmed: string): boolean {
  // Common forwarded/replied header blocks:
  // From: ...
  // Sent: ...
  // To: ...
  // Subject: ...
  return /^(from|sent|to|subject|cc):\s+/i.test(lineTrimmed);
}

function isQuoteSeparator(lineTrimmed: string): boolean {
  if (lineTrimmed.length === 0) return false;
  if (/^On .+wrote:\s*$/i.test(lineTrimmed)) return true;
  if (/^[-_]{2,}\s*Original Message\s*[-_]{2,}\s*$/i.test(lineTrimmed)) return true;
  if (/^Begin forwarded message:\s*$/i.test(lineTrimmed)) return true;
  if (/^>+/.test(lineTrimmed)) return true;
  if (isOutlookHeaderBlockStart(lineTrimmed)) return true;
  return false;
}

export function extractNewestMessageText(bodyText: string): string {
  const lines = bodyText.split(/\r?\n/);
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const t = raw.trim();

    // Stop at the first sign of quoted history.
    if (isQuoteSeparator(t)) break;

    kept.push(raw);
  }

  let text = kept.join("\n").trim();

  // Strip common signatures (best-effort).
  text = text.replace(/\n--\s*\n[\s\S]*$/m, "").trim();
  text = text.replace(/\nSent from my iPhone[\s\S]*$/i, "").trim();

  return text;
}

function findAllMatchesWithSpans(haystack: string, needle: string): Array<{ start: number; end: number }> {
  if (!needle || !haystack) return [];
  const escaped = escapeRegExp(needle);
  const re = new RegExp(`(^|\\s)(${escaped})(?=$|\\s)`, "g");
  const spans: Array<{ start: number; end: number }> = [];

  let m: RegExpExecArray | null;
  while ((m = re.exec(haystack)) != null) {
    const prefix = m[1] ?? "";
    const matchText = m[2] ?? "";
    const start = (m.index ?? 0) + prefix.length;
    const end = start + matchText.length;
    spans.push({ start, end });
  }
  return spans;
}

function spansOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Longest-name-wins envelope mention extraction.
 * - sort known names by length desc
 * - boundary match (case-insensitive)
 * - suppress overlaps so shorter names inside longer names don’t double-count
 */
export function extractMentionedEnvelopes(cleanText: string, matchIndex: EnvelopeMatchIndex): string[] {
  const normalizedText = normalizeEnvelopeText(cleanText);
  const entriesSorted = matchIndex.entries.slice().sort((a, b) => b.normalizedMatch.length - a.normalizedMatch.length);
  const picked: Array<{ canonical: string; start: number }> = [];
  const pickedCanonical = new Set<string>();
  const usedSpans: Array<{ start: number; end: number }> = [];

  for (const entry of entriesSorted) {
    if (!entry.normalizedMatch) continue;
    const spans = findAllMatchesWithSpans(normalizedText, entry.normalizedMatch);
    for (const span of spans) {
      if (usedSpans.some((s) => spansOverlap(s, span))) continue;
      usedSpans.push(span);
      if (!pickedCanonical.has(entry.canonicalName)) {
        pickedCanonical.add(entry.canonicalName);
        picked.push({ canonical: entry.canonicalName, start: span.start });
      }
      break; // only need to record the name once
    }
  }

  picked.sort((a, b) => a.start - b.start);
  return picked.map((p) => p.canonical);
}

function bestEnvelopeMatch(fragment: string, matchIndex: EnvelopeMatchIndex): string | undefined {
  const frag = normalizeEnvelopeText(fragment);
  if (!frag) return undefined;
  const entriesSorted = matchIndex.entries.slice().sort((a, b) => b.normalizedMatch.length - a.normalizedMatch.length);
  for (const entry of entriesSorted) {
    if (!entry.normalizedMatch) continue;
    const spans = findAllMatchesWithSpans(frag, entry.normalizedMatch);
    if (spans.length > 0) return entry.canonicalName;
  }
  return undefined;
}

export function bestEnvelopeGuess(fragment: string, matchIndex: EnvelopeMatchIndex): string | undefined {
  const frag = normalizeEnvelopeText(fragment);
  if (!frag) return undefined;
  const tokens = frag.split(" ").filter((t) => t.length >= 3);
  if (tokens.length === 0) return undefined;

  let best: { name: string; score: number; length: number } | null = null;
  for (const [name, normalizedMatches] of matchIndex.normalizedByCanonical.entries()) {
    let bestScore = 0;
    let bestLength = 0;
    for (const match of normalizedMatches) {
      const matchTokens = match.split(" ").filter((t) => t.length > 0);
      const tokenSet = new Set(matchTokens);
      const score = tokens.reduce((acc, t) => acc + (tokenSet.has(t) ? 1 : 0), 0);
      if (score > bestScore || (score === bestScore && match.length > bestLength)) {
        bestScore = score;
        bestLength = match.length;
      }
    }
    if (bestScore <= 0) continue;
    if (!best || bestScore > best.score || (bestScore === best.score && bestLength > best.length)) {
      best = { name, score: bestScore, length: bestLength };
    }
  }

  return best?.name;
}

function parseAmountDollars(text: string): number | undefined {
  const t = text.toLowerCase();

  // $80 or $80.50
  {
    const m = t.match(/\$\s*([0-9]+(?:\.[0-9]{1,2})?)/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }

  // 80 dollars / 80 usd / 80 bucks
  {
    const m = t.match(/\b([0-9]+(?:\.[0-9]{1,2})?)\s*(dollars|usd|bucks)\b/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }

  return undefined;
}

export function extractTransferFragments(cleanText: string): { fromFragment?: string; toFragment?: string } {
  const m1 = cleanText.match(/\bfrom\b\s*([^\n]{0,80}?)\s*\bto\b\s*([^\n]{0,80}?)(?:[\n.!?]|$)/i);
  const m2 = !m1 ? cleanText.match(/([^\n]{0,80}?)\s*(?:->|→)\s*([^\n]{0,80}?)(?:[\n.!?]|$)/) : null;
  return {
    ...(m1 ? { fromFragment: m1[1], toFragment: m1[2] } : {}),
    ...(m2 ? { fromFragment: m2[1], toFragment: m2[2] } : {}),
  };
}

export function extractTransfer(cleanText: string, matchIndex: EnvelopeMatchIndex): TransferHint | undefined {
  const amount = parseAmountDollars(cleanText);

  const fragments = extractTransferFragments(cleanText);
  const fromFrag = fragments.fromFragment ?? null;
  const toFrag = fragments.toFragment ?? null;

  const from = fromFrag ? bestEnvelopeMatch(fromFrag, matchIndex) : undefined;
  const to = toFrag ? bestEnvelopeMatch(toFrag, matchIndex) : undefined;

  if (amount == null && !from && !to) return undefined;
  return { amount, from, to };
}

export function parseFixitEmail(opts: { bodyText: string; knownEnvelopeRules: EnvelopeRule[] }): ParsedFixitEmail {
  const cleanText = extractNewestMessageText(opts.bodyText);
  const cleanTextLower = cleanText.trim().toLowerCase();
  const commands = parseEmailCommands(cleanText);
  const matchIndex = buildEnvelopeMatchIndex(opts.knownEnvelopeRules);
  const mentionedEnvelopes = extractMentionedEnvelopes(cleanText, matchIndex);
  const transfer = extractTransfer(cleanText, matchIndex);

  return { cleanText, cleanTextLower, commands, mentionedEnvelopes, ...(transfer ? { transfer } : {}) };
}

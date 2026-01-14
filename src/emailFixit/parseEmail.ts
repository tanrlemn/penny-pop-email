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
  // Boundary-aware, case-insensitive match:
  // - preceding char is non-alnum (or start)
  // - following char is non-alnum (or end)
  const escaped = escapeRegExp(needle);
  const re = new RegExp(`(^|[^A-Za-z0-9])(${escaped})(?=$|[^A-Za-z0-9])`, "gi");
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
export function extractMentionedEnvelopes(cleanText: string, knownEnvelopeNames: string[]): string[] {
  const namesSorted = knownEnvelopeNames.slice().sort((a, b) => b.length - a.length);
  const picked: string[] = [];
  const usedSpans: Array<{ start: number; end: number }> = [];

  for (const name of namesSorted) {
    if (!name || !name.trim()) continue;
    const spans = findAllMatchesWithSpans(cleanText, name);
    for (const span of spans) {
      if (usedSpans.some((s) => spansOverlap(s, span))) continue;
      usedSpans.push(span);
      picked.push(name);
      break; // only need to record the name once
    }
  }

  // Preserve a stable order for downstream: sort by first occurrence in text.
  picked.sort((a, b) => {
    const ia = cleanText.toLowerCase().indexOf(a.toLowerCase());
    const ib = cleanText.toLowerCase().indexOf(b.toLowerCase());
    return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
  });

  return picked;
}

function bestEnvelopeMatch(fragment: string, knownEnvelopeNames: string[]): string | undefined {
  const frag = fragment.trim();
  if (!frag) return undefined;
  const namesSorted = knownEnvelopeNames.slice().sort((a, b) => b.length - a.length);
  for (const name of namesSorted) {
    if (!name || !name.trim()) continue;
    const spans = findAllMatchesWithSpans(frag, name);
    if (spans.length > 0) return name;
  }
  return undefined;
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

export function extractTransfer(cleanText: string, knownEnvelopeNames: string[]): TransferHint | undefined {
  const amount = parseAmountDollars(cleanText);

  // from X to Y
  const m1 = cleanText.match(/\bfrom\b\s*([^\n]{0,80}?)\s*\bto\b\s*([^\n]{0,80}?)(?:[\n.!?]|$)/i);
  // X -> Y or X → Y
  const m2 = !m1 ? cleanText.match(/([^\n]{0,80}?)\s*(?:->|→)\s*([^\n]{0,80}?)(?:[\n.!?]|$)/) : null;

  const fromFrag = m1 ? m1[1] : m2 ? m2[1] : null;
  const toFrag = m1 ? m1[2] : m2 ? m2[2] : null;

  const from = fromFrag ? bestEnvelopeMatch(fromFrag, knownEnvelopeNames) : undefined;
  const to = toFrag ? bestEnvelopeMatch(toFrag, knownEnvelopeNames) : undefined;

  if (amount == null && !from && !to) return undefined;
  return { amount, from, to };
}

export function parseFixitEmail(opts: { bodyText: string; knownEnvelopeNames: string[] }): ParsedFixitEmail {
  const cleanText = extractNewestMessageText(opts.bodyText);
  const cleanTextLower = cleanText.trim().toLowerCase();
  const commands = parseEmailCommands(cleanText);
  const mentionedEnvelopes = extractMentionedEnvelopes(cleanText, opts.knownEnvelopeNames);
  const transfer = extractTransfer(cleanText, opts.knownEnvelopeNames);

  return { cleanText, cleanTextLower, commands, mentionedEnvelopes, ...(transfer ? { transfer } : {}) };
}

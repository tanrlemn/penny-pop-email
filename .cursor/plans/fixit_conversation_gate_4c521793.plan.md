---
name: Fixit_conversation_gate
overview: Add an intent ladder + scope extraction so Fixit only runs the deterministic engine when the newest email message contains a specific, actionable request, and when it does, it only replies about the in-scope envelopes (no global issue dump). APPLY remains highest priority and unchanged.
todos:
  - id: parse-newest-message
    content: Implement newest-message extraction + envelope/transfer parsing (incl longest-name-wins matching) in src/emailFixit/parseEmail.ts
    status: completed
  - id: intent-classifier
    content: Replace classifyTask with intent ladder output (incl HELP + better unknown handling; intent/reason/confidence/scope/primary) in src/emailFixit/classifyTask.ts
    status: completed
  - id: scoped-generatePlans
    content: Add scopeEnvelopeNames filtering to src/envelopes/generatePlans.ts (issues filtered; donors allowed intentionally)
    status: completed
  - id: poller-routing
    content: Update src/emailFixit/poller.ts to route by intent (TEST/HELP/GENERIC/SPECIFIC/APPLY) and pass full scope (from+to+mentions) into engine
    status: completed
  - id: reply-variants
    content: Add TEST + HELP + GENERIC + scoped SPECIFIC reply composers in src/emailFixit/replyComposer.ts; integrate protected-touch clarification and optional Related section
    status: completed
---

## Goals

- **Natural language first**: Gmail label selects candidates; **newest message text** decides how deep to go.
- **Intent ladder**: `APPLY` (wins) > `TEST` > `SPECIFIC_FIX` > `GENERIC_FIX` > `HELP` (default for unknown/short “??” style).
- **Scope**: when `SPECIFIC_FIX`, only generate plans for issues whose `envelopeName` is in the extracted scope.
- **Scoped but complete**: for transfers, scope must include **both** `from` and `to` (plus any envelope mentions), even if the primary issue is one side.
- **No new infrastructure**: reuse existing DB + deterministic engine; only add parsing, gating, scope filtering, and reply variants.

## Current flow (what changes)

- Poller currently parses commands and then always runs full engine for non-APPLY:
```228:270:/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny_pop_email_app/src/emailFixit/poller.ts
    const commands = parseEmailCommands(msg.bodyText);
    const task = classifyEmailTask({ bodyText: msg.bodyText, commands });

    if (task.kind === "apply_decision") {
      const reply = await handleApply({
        fromEmail,
        gmailMessageId: msg.id,
        threadId: msg.threadId,
        bodyText: msg.bodyText,
        chosen: task.option,
        allowProtectedReduction: Boolean(commands.allowProtectedReduction),
        allowSafetyNet: Boolean(commands.allowSafetyNet),
        decisionToken: commands.decisionToken ?? null,
      });
      // ... send + log ...
      continue;
    }

    const { subject, text, decisionToken, plans } = await handleFixit({
      fromEmail,
      gmailMessageId: msg.id,
      threadId: msg.threadId,
      bodyText: msg.bodyText,
      allowSafetyNet: Boolean(commands.allowSafetyNet),
      allowProtectedReduction: Boolean(commands.allowProtectedReduction),
      restoreDays: commands.restoreDays ?? null,
      phase: commands.phase ?? "DEFAULT",
    });
```


## Design

### 1) Parse newest-message only (strip quoted history)

Add a new parsing entrypoint in [`src/emailFixit/parseEmail.ts`](/Volumes/Crucial%20X10/other-work/Penny%20Pixel%20Pop/penny_pop_email_app/src/emailFixit/parseEmail.ts):

- `extractNewestMessageText(bodyText: string): string`
  - Stop at common quote separators: `^On .*wrote:$`, `^-----Original Message-----`, leading `>` quote blocks, Outlook-style header blocks (`From:`, `Sent:`, `To:`, `Subject:`).
  - Optionally strip common signatures (`Sent from my iPhone`, `--`).
- `parseFixitEmail(opts: { bodyText: string; knownEnvelopeNames: string[] }): ParsedFixitEmail`
  - Derive `cleanText` from newest message only.
  - Run **existing command token parsing** on `cleanText` (not the full thread) so APPLY/TOKEN/ALLOW/PHASE/RESTORE can’t be accidentally picked up from quoted history.
  - Extract `mentionedEnvelopes` via matching against `knownEnvelopeNames` with **longest-name-wins**:
    - sort known names by length desc
    - boundary match (case-insensitive)
    - when matches overlap, keep the longer match and suppress shorter overlaps (e.g. “Gas/Water (Citizens)” beats “Gas”).
  - Extract `transfer?: { amount?: number; from?: string; to?: string }` via:
    - amount: `$80`, `$80.50`, `80 dollars` / `80 usd`
    - from/to: `from X to Y` (and a few variants like `X -> Y`), choosing the **best** envelope match in each fragment.

### 2) Intent classification (conversation gate)

Replace the current task classifier:

```3:21:/Volumes/Crucial X10/other-work/Penny Pixel Pop/penny_pop_email_app/src/emailFixit/classifyTask.ts
export type EmailTask =
  | { kind: "apply_decision"; option: "A" | "B" | "C" }
  | { kind: "fixit_request" };

export function classifyEmailTask(opts: { bodyText: string; commands: ParsedEmailCommands }): EmailTask {
  const { bodyText, commands } = opts;

  if (commands.applyOption) {
    return { kind: "apply_decision", option: commands.applyOption };
  }

  // Heuristic: anything else is a fixit request; the deterministic engine will decide issue type(s).
  const lower = bodyText.toLowerCase();
  if (lower.includes("apply ")) {
    // Avoid accidental matches; rely on explicit APPLY parsing above.
  }

  return { kind: "fixit_request" };
}
```

…with `FixitIntent` + reasons/confidence, including a dedicated `HELP` for help/commands/unknowns.

### 3) Scoped plan generation

Extend [`src/envelopes/generatePlans.ts`](/Volumes/Crucial%20X10/other-work/Penny%20Pixel%20Pop/penny_pop_email_app/src/envelopes/generatePlans.ts) to accept `scopeEnvelopeNames?: string[]` and filter `issues` up front.

- Deterministic calculations remain unchanged; this is just an input filter.
- Only call site is Fixit poller today.

### 4) Reply flow variants

Add HELP + 2 existing variants and a scoped variant:

- `composeTestReply()` (<=6 lines, includes 2 examples)
- `composeGenericFixReply()` (must start with `Fix what?`, include 3 examples)
- `composeHelpReply()` (usage-style; can share the same examples as Generic but framed as “here’s what I can do”)
- `composeScopedFixitReply({ decisionToken, plan, phase, protectedTouchQuestion? })`
  - Show **one** A/B/C set for the chosen **primary** issue.
  - Present options ranked (recommended first).
  - Include decision token + APPLY instructions.
  - Optionally append exactly **one** clarifying question if recommended touches a protected pod and caller didn’t include `ALLOW`.
  - Optionally include a short “Related:” section for a directly implicated transfer endpoint (e.g., `from` side) **only if** it has an in-scope issue.

## Exact file-by-file changes

### A) `src/emailFixit/parseEmail.ts`

- **Keep**: `ParsedEmailCommands`, `parseEmailCommands` logic (but run it on newest-message text).
- **Add types**:
  - `export type FixitIntent = "TEST" | "GENERIC_FIX" | "SPECIFIC_FIX" | "APPLY" | "HELP";` (intent type will live in `classifyTask.ts`; this file only needs parsing types)
  - `export interface ParsedFixitEmail { cleanText: string; cleanTextLower: string; commands: ParsedEmailCommands; mentionedEnvelopes: string[]; transfer?: { amount?: number; from?: string; to?: string }; }`
- **Add functions**:
  - `extractNewestMessageText(bodyText: string): string`
  - `extractMentionedEnvelopes(cleanText: string, knownEnvelopeNames: string[]): string[]`
  - `extractTransfer(cleanText: string, knownEnvelopeNames: string[]): { amount?: number; from?: string; to?: string } | undefined`
  - `parseFixitEmail(...)` main entrypoint.

Mention matching implementation note (required):

- Sort `knownEnvelopeNames` by length desc once per parse.
- Use boundary-aware matching.
- When collecting `mentionedEnvelopes`, suppress overlaps so shorter names inside longer names don’t double-count.

### B) `src/emailFixit/classifyTask.ts`

- **Replace** `EmailTask` with a richer task:
```ts
export type FixitIntent = "TEST" | "GENERIC_FIX" | "SPECIFIC_FIX" | "APPLY" | "HELP";

export interface FixitEmailTask {
  intent: FixitIntent;
  reason: string;
  confidence: number; // 0..1
  // pass-through for downstream
  commands: ParsedEmailCommands;
  cleanText: string;
  mentionedEnvelopes: string[];
  transfer?: { amount?: number; from?: string; to?: string };
  scopeEnvelopeNames: string[]; // computed from mentioned + transfer endpoints
  primaryEnvelopeName?: string; // chosen for one_primary behavior
}
```

- **New** `classifyFixitEmail(parsed: ParsedFixitEmail): FixitEmailTask`
  - APPLY wins if `parsed.commands.applyOption`.
  - TEST if `cleanTextLower` is exactly `"test"` or `"ping"`.
  - `scopeEnvelopeNames` = unique([transfer.from, transfer.to, ...mentionedEnvelopes]) (must include **both** endpoints if present).
  - GENERIC_FIX if message implies “fix request” but has **no anchors**:
    - no amount, no mentioned envelopes, no from→to
  - HELP if:
    - message is help-ish (`help`, `commands`, `what can you do`, `?`) OR
    - message is very short (`t.length < 6`) and not TEST/APPLY and has no anchors OR
    - message is otherwise unrecognized (default: treat unknowns as HELP-ish).
  - SPECIFIC_FIX only if it has enough anchors (protect against “amount but no envelope”):
    - require **amount + (mentions OR from→to OR timing words)**, OR
    - require **from→to + transfer verb** (moved/transferred/borrowed), OR
    - require **mentions + timing words**.
  - If `SPECIFIC_FIX` but scope is empty => downgrade to `GENERIC_FIX`.
  - Primary envelope selection (per your choice):
    - if `transfer.to` -> primary = transfer.to
    - else if `mentionedEnvelopes.length === 1` -> that
    - else if `transfer.from` -> transfer.from
    - else first `mentionedEnvelopes[0]`

### C) `src/emailFixit/replyComposer.ts`

- **Add**:
  - `export function composeTestReply(): { subject: string; text: string }`
  - `export function composeGenericFixReply(): { subject: string; text: string }`
  - `export function composeHelpReply(): { subject: string; text: string }`
  - `export function composeScopedFixitReply(opts: { decisionToken: string; plan: FixPlan; phase: Phase; protectedClarify?: { envelopeName: string; allowHint: "ALLOW: protected" | "ALLOW: SafetyNet" } }): { subject: string; text: string }`
- **Keep** existing `composeApplyConfirmation` and `composeFixitReply` for now (useful for a future “full scan” mode if you ever want it back).

Reply copy requirements to implement:

- **TEST**: <=6 lines, 2 examples
- **GENERIC_FIX**: must start `Fix what?` and include 3 examples
- **HELP**: usage framed (“Here’s what I can do…”); include examples (can reuse the 3 Generic examples)
- **SPECIFIC_FIX**: no unrelated envelope issues (guaranteed by scoped plan filtering + choosing one primary plan)

### D) `src/envelopes/generatePlans.ts`

- **Change signature**:
```ts
export function generatePlans(opts: {
  issues: DetectedIssue[];
  states: EnvelopeState[];
  scopeEnvelopeNames?: string[];
  allowSafetyNet?: boolean;
  allowProtectedReduction?: boolean;
  dueSoonWindowDays: number;
  depositAmountAssumptionDollars: number;
  routingDeposits: number;
}): FixPlan[]
```

- **Implementation**: at top of `generatePlans`, if `scopeEnvelopeNames?.length`, filter `issues = issues.filter(i => scopeSet.has(i.envelopeName))`.
  - Note: **donors remain unrestricted**; plans may borrow from any safe donor. This is intentional. The “only talk about this thing” requirement is enforced by (a) filtering issues to scope and (b) composing replies from the scoped plan(s) only (no unrelated issue blocks).

### E) `src/emailFixit/poller.ts`

- Load known envelope names once per polling pass:
  - `const rules = await listEnvelopeRules(); const knownNames = rules.map(r => r.name);`
- Replace `parseEmailCommands(msg.bodyText)` with `parseFixitEmail({ bodyText: msg.bodyText, knownEnvelopeNames: knownNames })`.
- Replace `classifyEmailTask(...)` with `classifyFixitEmail(parsed)`.
- Route by intent:
  - **APPLY**: call existing `handleApply(...)` unchanged.
  - **TEST**: send `composeTestReply()`; do **not** call `fetchAccounts/detectIssues/generatePlans`.
  - **GENERIC_FIX**: send `composeGenericFixReply()`; do **not** run engine.
  - **HELP**: send `composeHelpReply()`; do **not** run engine.
  - **SPECIFIC_FIX**:
    - if `task.scopeEnvelopeNames` empty -> treat as GENERIC_FIX.
    - call a scoped engine function (either modify `handleFixit` to accept scope, or add `handleFixitScoped`) that:
      - runs `fetchAccounts`, `computeEnvelopeStates`, `detectIssues` (deterministic core unchanged)
      - calls `generatePlans({ ..., scopeEnvelopeNames: task.scopeEnvelopeNames })` (must include both `from` and `to` when present)
      - chooses a **primary plan** matching `primaryEnvelopeName` if available, else `plans[0]`
      - optionally finds a **related plan** for the other transfer endpoint (minimal rule): if `transfer.from` exists and differs from primary and has a plan, include a short “Related:” section
      - if none: reply “I don’t see an issue for <primary> right now. Tell me what change you want (transfer now vs routing vs rule).”
      - checks if **recommended option touches protected** envelope without allow:
        - if recommended option has a `transfer` step where `fromEnvelope` is protected
        - OR has `routing_override` with negative delta on a protected envelope
        - then append one clarifying question line (and hint to reply with `ALLOW: protected` or `ALLOW: SafetyNet`)
      - uses `composeScopedFixitReply(...)`
- Keep idempotency unchanged (still uses `tryMarkMessageProcessed`).

### F) `env.example` (optional but recommended)

- Add `FIXIT_INCLUDE_SEVERE_UNRELATED=0` (default off) if you want to support the “Also noticed:” line later.

## Updated/new TypeScript types (summary)

- `src/emailFixit/parseEmail.ts`
  - `ParsedFixitEmail`
  - `TransferHint`
- `src/emailFixit/classifyTask.ts`
  - `FixitIntent`
  - `FixitEmailTask` (includes `intent`, `reason`, `confidence`, `scopeEnvelopeNames`, `primaryEnvelopeName`)
- `src/envelopes/generatePlans.ts`
  - Extend opts with `scopeEnvelopeNames?: string[]`

## Pseudocode

### Intent ladder

```ts
function classifyFixitEmail(parsed): FixitEmailTask {
  const t = parsed.cleanTextLower.trim();

  // APPLY wins
  if (parsed.commands.applyOption) return { intent:"APPLY", reason:"explicit APPLY", confidence:1.0, ... };

  // TEST
  if (t === "test" || t === "ping") return { intent:"TEST", reason:"exact ping", confidence:1.0, ... };

  const hasAmount = parsed.transfer?.amount != null || /\$\s*\d/.test(t) || /\b\d+(?:\.\d+)?\s*(dollars|usd|bucks)\b/.test(t);
  const hasMentions = parsed.mentionedEnvelopes.length > 0;
  const hasFromTo = Boolean(parsed.transfer?.from && parsed.transfer?.to);
  const hasTransferVerb = /\b(moved|move|transfer(red)?|borrow(ed)?)\b/.test(t);
  const hasTiming = /\b(short|timing|due|overdue|past\s+due|late)\b/.test(t);
  const hasFixPhrase = /\b(fix\s+it|fix\s+this|help\s+me\s+fix|can\s+you\s+fix|please\s+fix|resolve\s+this)\b/.test(t);
  const isHelpish = /\b(help|commands|what can you do|what can you do\??|how do i)\b/.test(t) || t.includes("?");

  const scope = uniq([parsed.transfer?.from, parsed.transfer?.to, ...parsed.mentionedEnvelopes].filter(Boolean));

  // SPECIFIC (guard: amount alone is not enough)
  const specific = (hasAmount && (hasMentions || hasFromTo || hasTiming)) || (hasFromTo && hasTransferVerb) || (hasMentions && hasTiming);
  if (specific && scope.length > 0) {
    const primary = parsed.transfer?.to ?? (parsed.mentionedEnvelopes.length === 1 ? parsed.mentionedEnvelopes[0]
                  : parsed.transfer?.from ?? parsed.mentionedEnvelopes[0]);
    return { intent:"SPECIFIC_FIX", reason:"anchored request", confidence:0.8, scopeEnvelopeNames:scope, primaryEnvelopeName:primary, ... };
  }

  // GENERIC
  if (!hasAmount && !hasMentions && !hasFromTo && (hasFixPhrase || t.length === 0)) {
    return { intent:"GENERIC_FIX", reason:"no anchors", confidence:0.7, scopeEnvelopeNames:[], ... };
  }

  // HELP-ish (explicit help, very short, or unknown)
  if (isHelpish || t.length < 6) {
    return { intent:"HELP", reason:"help/short/unknown", confidence:0.7, scopeEnvelopeNames:[], ... };
  }

  // default: unknowns become HELP-ish
  return { intent:"HELP", reason:"unrecognized; showing usage", confidence:0.5, scopeEnvelopeNames:[], ... };
}
```

### Scope extraction

```ts
function extractTransfer(cleanText, knownNames) {
  const amount = parseAmount(cleanText);
  const m = cleanText.match(/\bfrom\b(.{0,80}?)\bto\b(.{0,80}?)(?:[\n\.\!\?]|$)/i)
        ?? cleanText.match(/(.{0,80}?)->(.{0,80}?)(?:[\n\.\!\?]|$)/);
  if (!m) return amount ? { amount } : undefined;

  const fromFrag = m[1];
  const toFrag = m[2];
  const from = bestEnvelopeMatch(fromFrag, knownNames);
  const to = bestEnvelopeMatch(toFrag, knownNames);

  if (!from && !to && amount == null) return undefined;
  return { amount, from, to };
}

function extractMentionedEnvelopes(cleanText, knownNames) {
  // longest-name-wins:
  // - sort names length desc
  // - boundary match
  // - track matched spans; suppress overlaps so shorter names inside longer names don’t double-count
}
```

## Test cases (email -> intent/scope/behavior)

1) **APPLY wins over everything**

- Input newest message: `ping\nAPPLY B abc12345`
- Expected: `intent=APPLY`, behavior: apply flow unchanged.

2) **TEST**

- Input: `Ping`
- Expected: `intent=TEST`, reply <=6 lines, includes 2 examples, no engine calls.

3) **GENERIC_FIX (no anchors)**

- Input: `can you fix it`
- Expected: `intent=GENERIC_FIX`, scope `[]`, reply starts `Fix what?` and includes 3 examples, no engine calls.

4) **SPECIFIC_FIX via amount + envelope**

- Known envelopes: `["Groceries", "Dining"]`
- Input: `Groceries is short by $80`
- Expected: `intent=SPECIFIC_FIX`, scope `["Groceries"]`, primary `Groceries`, engine runs but plans filtered to Groceries only.

5) **SPECIFIC_FIX via transfer**

- Known envelopes: `["Groceries", "Dining"]`
- Input: `I moved $50 from Groceries to Dining`
- Expected: `intent=SPECIFIC_FIX`, scope includes `["Groceries","Dining"]`, primary `Dining`, reply shows Dining first; may include short “Related:” for Groceries only if Groceries has an in-scope issue; no unrelated envelope issues.

6) **SPECIFIC_FIX via due wording**

- Input: `Rent due soon—looks short`
- Expected: if `Rent` is a known envelope, `intent=SPECIFIC_FIX`, scope `["Rent"]`.

7) **Quoted history is ignored**

- Input:
  - Newest: `test`
  - Quoted contains: `APPLY A deadbeef`
- Expected: `intent=TEST` (APPLY not triggered), because parsing runs on newest-message only.

8) **Protected-touch clarifying question**

- Input: `Utilities is short $200`
- If recommended option’s steps would reduce a protected donor and no `ALLOW` present:
  - Expected: `intent=SPECIFIC_FIX` and reply appends one question + hint: `ALLOW: protected` (or `ALLOW: SafetyNet` when applicable).

9) **HELP: explicit help**

- Input: `help` or `what can you do?`
- Expected: `intent=HELP`, reply is usage-framed with examples, no engine calls.

10) **HELP: very short / punctuation**

- Input: `yo` or `??`
- Expected: `intent=HELP` (or `GENERIC_FIX` if it includes a fix phrase), reply asks for a concrete request + examples, no engine calls.

11) **Guard: amount but no envelope**

- Input: `We moved $80, help`
- Expected: `intent=GENERIC_FIX` or `HELP` (depending on wording), scope `[]`, reply explicitly asks which envelope it came from and went to; no engine calls.
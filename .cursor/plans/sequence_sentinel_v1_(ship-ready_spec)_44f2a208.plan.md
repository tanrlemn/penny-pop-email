---
name: Sequence Sentinel v1 (ship-ready spec)
overview: Ship-ready plan for a no-UI TypeScript sentinel that fetches Sequence balances, computes a configured savings total, persists to a private GitHub Gist with extensible state, marks partial snapshots when balances are missing, analyzes trend using non-partial history, and emails weekly plus immediate RED with cooldown and missing-data safeguards.
todos:
  - id: scaffold-project
    content: Create Node/TypeScript project files (package.json, tsconfig.json) and source layout under src/ plus README/.env.example.
    status: pending
  - id: sequence-client
    content: Implement Sequence POST /accounts client and normalize results into SequenceAccount[] with balanceDollars nullable.
    status: pending
    dependencies:
      - scaffold-project
  - id: classify-partial
    content: Compute savingsTotal from configured names and emit partial/missing[] when any tracked savings account balance is unavailable.
    status: pending
    dependencies:
      - sequence-client
  - id: gist-persisted-state
    content: Implement Gist persistence using PersistedState object {version,snapshots,lastAlert} with safe fallback on invalid/missing JSON.
    status: pending
    dependencies:
      - scaffold-project
  - id: analyze-reason-codes
    content: Implement analyzer that outputs level + reasonCode, computes delta/slope/projection only when today and lookback are non-partial, and uses a backward search window for a non-partial lookback snapshot.
    status: pending
    dependencies:
      - gist-persisted-state
      - classify-partial
  - id: alerts-cooldown
    content: Implement weekly summary + immediate RED with 2-day cooldown; suppress immediate RED when today is partial; update lastAlert only when an email is sent.
    status: pending
    dependencies:
      - analyze-reason-codes
  - id: email-templates
    content: Implement templates that render the right kind of YELLOW based on reasonCode and include missing-balance notes and projection metrics.
    status: pending
    dependencies:
      - alerts-cooldown
  - id: github-actions
    content: Add scheduled GitHub Actions workflow and document secrets plus steps to create the private Gist and Gist token.
    status: pending
    dependencies:
      - email-templates
---

# Sequence Savings Sentinel (TypeScript, no-UI) — ship-ready spec

## Decisions locked in

- **Scheduler**: GitHub Actions cron
- **Snapshot persistence**: private GitHub Gist (manual creation)
- **Email**: SMTP via Nodemailer
- **Alert policy**: weekly summary + immediate RED with 2-day cooldown
- **Pods count as savings**: yes (names-based inclusion)

## Reliability policies (final)

- **Missing balances are unknown, not $0**
- If any configured savings account returns `balanceDollars: null`, the run is treated as **partial**.
- We may still compute a **provisional** `savingsTotal` from available balances for display/snapshotting, but decisioning must not treat missing balances as zero.
- **Partial-day alerting**
- If today is partial: status is **YELLOW** with `reasonCode="MISSING_DATA"`.
- Immediate RED is suppressed when today is partial.
- Weekly summary still sends even if today is partial and includes a clear “data incomplete today” note.
- **First-run / missing-history**
- If no suitable non-partial lookback snapshot exists, treat as `reasonCode="BASELINE"`.
- Baseline runs email only on weekly day, with message: “Collecting baseline; no trend yet.”

## Persisted state schema (Gist)

- The Gist stores an object (not a bare array):
```json
{
  "version": 1,
  "snapshots": [
    { "date": "YYYY-MM-DD", "savingsTotal": 123.45, "partial": false, "missing": [] }
  ],
  "lastAlert": { "level": "RED" | "YELLOW", "date": "YYYY-MM-DD" } | null
}
```




- `lastAlert` is updated only when an email is actually sent.

## Data structures (TypeScript)

- `Snapshot`:
- `{ date: string; savingsTotal: number; partial?: boolean; missing?: string[] }`
- `PersistedState`:
- `{ version: 1; snapshots: Snapshot[]; lastAlert?: { level: "RED" | "YELLOW"; date: string } | null }`
- `Status`:
- `level: "GREEN" | "YELLOW" | "RED"`
- `reasonCode: "UP" | "FLAT" | "DOWN" | "MISSING_DATA" | "BASELINE"`
- `lookbackDays: number`
- `delta?: number` (only when trend is computed from a non-partial comparison)
- `slopePerDay?: number`
- `projectedMonthly?: number`
- `reason: string`

## Analysis rules (trend selection)

- Inputs:
- `todayISO` (YYYY-MM-DD)
- `lookbackDays` (e.g. 7)
- `lookbackSearchWindowDays` (default 3)
- Steps:
- If today snapshot is `partial === true`:
    - Return `level="YELLOW"`, `reasonCode="MISSING_DATA"`.
    - Do not compute `delta/slope/projectedMonthly`.
- Else find a comparison snapshot:
    - Compute `targetDate = todayISO - lookbackDays`.
    - Prefer snapshot exactly on `targetDate` if `partial !== true`.
    - If the snapshot on `targetDate` is partial or missing, walk backward day-by-day up to `lookbackSearchWindowDays` to find the most recent `partial !== true` snapshot.
    - If none found in that window: return baseline (`reasonCode="BASELINE"`).
- If comparison exists:
    - `delta = today.savingsTotal - comparison.savingsTotal`
    - `slopePerDay = delta / lookbackDays`
    - `projectedMonthly = slopePerDay * 30`
    - Classification:
    - RED if `delta < -redDownDollarsOverLookback`
    - YELLOW if `|delta| <= flatBandDollars` (reasonCode `FLAT`)
    - GREEN otherwise (reasonCode `UP`)
    - If delta is negative but not RED, use `reasonCode="DOWN"` and `level` should remain GREEN or YELLOW per threshold logic (implementation detail: keep levels as previously defined; `reasonCode` communicates direction).

## Alert decision rules

- Weekly summary:
- Send on configured weekday regardless of partial/non-partial.
- Immediate RED:
- Send only when `status.level === "RED"` and today is not partial.
- Apply cooldown using `lastAlert`:
    - Default `redCooldownDays=2`
    - If `lastAlert.level === "RED"` and `lastAlert.date` is within the last `redCooldownDays`, suppress.

## Email content requirements

- Always include:
- Status level and reasonCode
- Today savingsTotal (provisional if partial)
- If trend computed: delta, slope per day, projected monthly change
- If partial: “Data incomplete today; trend may be unreliable.” and list missing account names
- Tracked savings account names

## Repo layout to create

- `src/index.ts` (entrypoint + cadence and cooldown policy)
- `src/types.ts` (types above)
- `src/config.ts` (editable names, thresholds, cadence, alert settings)
- `src/sequenceClient.ts` (POST `/accounts` + normalization)
- `src/classify.ts` (compute total + produce missing[] + partial)
- `src/snapshotStore.ts` (Gist read/write of PersistedState)
- `src/analyze.ts` (analysis rules above)
- `src/email.ts` (SMTP via Nodemailer)
- `src/templates.ts` (subject/body with reasonCode-specific wording)
- `.github/workflows/sentinel.yml`
- `package.json`, `tsconfig.json`, `.env.example`, `README.md`

## Config additions

Add to `src/config.ts`:

- `alerts: { redCooldownDays: 2, lookbackSearchWindowDays: 3 }`

## GitHub Actions workflow

- `on: schedule` daily + `workflow_dispatch`
- Node 20, `npm ci`, build, run
- Secrets injected as env vars.

## Required secrets / env vars

- **Sequence**: `SEQ_TOKEN`
- **Gist**: `GIST_ID`, `GIST_TOKEN`, optional `GIST_FILENAME` (default `state.json`)
- **SMTP**: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `EMAIL_TO`

## Implementation todos

- Scaffold TypeScript project and repo structure
- Implement Sequence client and account normalization
- Implement savings classification producing {savingsTotal, partial, missing[]}
- Implement Gist-backed PersistedState read/write with schema fallback
- Implement analysis with reasonCode, partial handling, and non-partial lookback search window
- Implement alert decisioning (weekly + RED cooldown + partial suppression)
- Implement templates and Nodemailer sender
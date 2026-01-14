# Sequence Savings Sentinel

No-UI savings trend sentinel that emails **GREEN / YELLOW / RED** based on whether your configured savings total is growing over a lookback window. It uses balances-only data from Sequence and persists state in a private GitHub Gist.

## What it does
- Fetches balances from Sequence (`POST https://api.getsequence.io/accounts` with `x-sequence-access-token: Bearer <token>`).
- Computes a **Savings Total** from a configured allow-list of account/pod names.
- Writes a daily snapshot to a **private GitHub Gist** (`state.json`).
- Classifies trend over `lookbackDays` as:
  - GREEN: up meaningfully
  - YELLOW: flat, down-but-not-catastrophic, missing data, or baseline
  - RED: down more than the configured threshold
- Sends an email every time it runs (cadence controlled by GitHub Actions cron).

## Setup

### 1) Create the private Gist
Create a private Gist containing a file named `state.json`.

You can leave it empty, or initialize it with:

```json
{ "version": 1, "snapshots": [], "lastAlert": null }
```

Save the Gist ID (the long hex-ish id in the URL).

### 2) Create a GitHub token for the Gist
Create a token that can read/write that Gist.

- Classic PAT: `gist` scope
- Fine-grained token: permissions to manage your gists

### 3) Configure savings account names
Edit `src/config.ts`:
- `classification.savingsNames`: the allow-list of savings accounts/pods you want to track
- thresholds/cadence/alerts as desired

### 4) Environment variables
This repo includes `env.example` (the environment blocks `.env.example` creation here). Copy it to `.env` for local runs, or set the same keys as GitHub secrets.

Required keys:
- `SEQ_TOKEN`
- `GIST_ID`, `GIST_TOKEN`, optional `GIST_FILENAME` (defaults to `state.json`)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`
- `EMAIL_FROM`, `EMAIL_TO`

## GitHub Actions deployment
Add repository secrets with the env vars above, then enable the workflow in `.github/workflows/sentinel.yml`.

Note: the sentinel uses **UTC dates** (`YYYY-MM-DD`) for snapshots (same as GitHub Actions).

## Local run
After installing dependencies:

```bash
npm install
npm run build
node dist/index.js
```

## Fixit (Gmail poller + rules engine)

This repo now supports an email-first “Fixit” loop backed by Turso (SQLite/libSQL):
- Gmail API polling (label-based)
- Deterministic envelope engine (floors + due funding)
- Plans labeled as Restore / Routing / Structural
- `APPLY A/B/C` replies that store routing overrides and/or rule changes

### Seed rules + routing baselines

Edit the example seed files:
- `seed/envelopeRules.example.json`
- `seed/routingBaselines.example.json`

Then run:

```bash
npm run seed
```

### Sync budgets from Google Sheet CSVs

1) Export `expenses.csv` + `income.csv` from the Google Sheet and copy them into `data/`.
2) (Optional) Adjust `seed/envelopeOverrides.json` or set `BUDGET_OVERRIDES_PATH`.
3) Run:

```bash
npm run budget:sync
```

4) Verify the audit output totals + diffs, then run Fixit:

```bash
npm run fixit:dev
```

### Run the Fixit worker

Set the env vars in `env.example` (especially Turso + Gmail OAuth2), then run:

```bash
npm run fixit:dev
```

This is intended to run on an always-on worker (e.g. a small DigitalOcean droplet). The weekly savings sentinel can continue to run via GitHub Actions.

### Manual checklist
- Transfer request: “I moved $80 from Groceries to Education” → ROUTING donor uses `Move to ___`, not a protected envelope (e.g. Car Payment).

## Sequence Remote API (deposit routing)

For Sequence “Remote API Action” amount lookup, deploy the `api/sequence-routing.ts` endpoint (Vercel recommended).

You’ll configure one remote amount URL per transfer action, passing the destination pod name as a query param:

- `.../api/sequence-routing?pod=Car%20Payment`
- `.../api/sequence-routing?pod=Education`

The endpoint returns `{ "amountInCents": <number> }` for that pod based on baseline bps + active overrides (with remainder flowing to `Move to ___`).



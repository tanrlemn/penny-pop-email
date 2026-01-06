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



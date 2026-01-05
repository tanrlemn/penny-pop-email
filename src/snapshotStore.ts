import { PersistedStateV1, Snapshot } from "./types";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_FILENAME = "state.json";

function defaultState(): PersistedStateV1 {
  return { version: 1, snapshots: [], lastAlert: null };
}

function statePathLocal() {
  return path.join(process.cwd(), "data", "state.json");
}

function isNonEmptyString(s: unknown): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

function isPersistedStateV1(x: any): x is PersistedStateV1 {
  return (
    x &&
    x.version === 1 &&
    Array.isArray(x.snapshots) &&
    (x.lastAlert == null ||
      (typeof x.lastAlert === "object" &&
        (x.lastAlert.level === "RED" || x.lastAlert.level === "YELLOW") &&
        typeof x.lastAlert.date === "string"))
  );
}

async function githubFetch(url: string, init: RequestInit): Promise<Response> {
  const token = process.env.GIST_TOKEN;
  if (!token) throw new Error("Missing GIST_TOKEN env var");

  const headers = new Headers(init.headers);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  headers.set("Authorization", `Bearer ${token}`);

  return fetch(url, { ...init, headers });
}

export function upsertSnapshot(snapshots: Snapshot[], snapshot: Snapshot): Snapshot[] {
  const filtered = snapshots.filter((s) => s.date !== snapshot.date);
  const next = [...filtered, snapshot].sort((a, b) => a.date.localeCompare(b.date));
  return next.slice(-180);
}

export async function loadState(): Promise<PersistedStateV1> {
  const gistId = process.env.GIST_ID;
  if (isNonEmptyString(gistId)) return loadStateFromGist(gistId);
  return loadStateFromLocal();
}

export async function saveState(state: PersistedStateV1): Promise<void> {
  const gistId = process.env.GIST_ID;
  if (isNonEmptyString(gistId)) return saveStateToGist(gistId, state);
  return saveStateToLocal(state);
}

async function loadStateFromGist(gistId: string): Promise<PersistedStateV1> {
  const filename = process.env.GIST_FILENAME || DEFAULT_FILENAME;
  const url = `https://api.github.com/gists/${encodeURIComponent(gistId)}`;

  const res = await githubFetch(url, { method: "GET" });
  if (!res.ok) throw new Error(`Gist read error: ${res.status} ${await res.text()}`);

  const json = (await res.json()) as any;
  const file = json?.files?.[filename];
  if (!file) return defaultState();

  let content: string | undefined = file.content;
  if (file.truncated === true && typeof file.raw_url === "string") {
    const rawRes = await githubFetch(file.raw_url, { method: "GET" });
    if (rawRes.ok) content = await rawRes.text();
  }

  if (!isNonEmptyString(content)) return defaultState();

  try {
    const parsed = JSON.parse(content);
    return isPersistedStateV1(parsed) ? parsed : defaultState();
  } catch {
    return defaultState();
  }
}

async function saveStateToGist(gistId: string, state: PersistedStateV1): Promise<void> {
  const filename = process.env.GIST_FILENAME || DEFAULT_FILENAME;
  const url = `https://api.github.com/gists/${encodeURIComponent(gistId)}`;

  const res = await githubFetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      files: {
        [filename]: {
          content: JSON.stringify(state, null, 2),
        },
      },
    }),
  });

  if (!res.ok) throw new Error(`Gist write error: ${res.status} ${await res.text()}`);
}

async function loadStateFromLocal(): Promise<PersistedStateV1> {
  const p = statePathLocal();
  if (!fs.existsSync(p)) return defaultState();
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return isPersistedStateV1(parsed) ? parsed : defaultState();
  } catch {
    return defaultState();
  }
}

async function saveStateToLocal(state: PersistedStateV1): Promise<void> {
  const p = statePathLocal();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}



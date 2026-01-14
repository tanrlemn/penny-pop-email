// NOTE: This repo compiles to CommonJS. The official libSQL client can be ESM-only
// depending on version, so we load it via dynamic import to stay compatible.

export type LibsqlClient = {
  execute: (args: { sql: string; args?: any[] }) => Promise<{
    rows: any[];
    rowsAffected: number;
    lastInsertRowid?: string | number | bigint | null;
  }>;
};

let cachedClientPromise: Promise<LibsqlClient> | null = null;

async function create(): Promise<LibsqlClient> {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("Missing TURSO_DATABASE_URL env var");
  if (!authToken) throw new Error("Missing TURSO_AUTH_TOKEN env var");

  const mod = (await import("@libsql/client")) as any;
  const createClient: (opts: { url: string; authToken?: string }) => LibsqlClient =
    mod.createClient ?? mod.default?.createClient ?? mod.default ?? mod;

  const client = createClient({ url, authToken });
  return client;
}

export async function getDb(): Promise<LibsqlClient> {
  if (!cachedClientPromise) cachedClientPromise = create();
  return cachedClientPromise;
}

export async function dbExec(sql: string, args: any[] = []) {
  const db = await getDb();
  return db.execute({ sql, args });
}

export async function dbGetOne<T>(sql: string, args: any[] = []): Promise<T | null> {
  const res = await dbExec(sql, args);
  const row = res.rows[0];
  return (row as T) ?? null;
}

export async function dbGetAll<T>(sql: string, args: any[] = []): Promise<T[]> {
  const res = await dbExec(sql, args);
  return res.rows as T[];
}


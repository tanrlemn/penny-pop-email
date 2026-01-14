import { dbExec } from "./libsqlClient";

export async function tryMarkMessageProcessed(opts: {
  gmailMessageId: string;
  threadId?: string | null;
  fromEmail?: string | null;
  receivedAtISO: string;
}): Promise<boolean> {
  const res = await dbExec(
    `INSERT OR IGNORE INTO processed_messages(gmail_message_id, thread_id, from_email, received_at)
     VALUES (?, ?, ?, ?);`,
    [opts.gmailMessageId, opts.threadId ?? null, opts.fromEmail ?? null, opts.receivedAtISO]
  );
  return res.rowsAffected > 0;
}


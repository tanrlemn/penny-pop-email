import { randomUUID } from "node:crypto";
import { dbExec, dbGetOne } from "./libsqlClient";

function nowISO() {
  return new Date().toISOString();
}

export interface MessageLogRecord {
  id: string;
  gmailMessageId?: string | null;
  threadId?: string | null;
  direction: "in" | "out";
  fromEmail?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  classification?: string | null;
  planJson?: string | null;
  decisionToken?: string | null;
  chosenOption?: string | null;
  createdAtISO: string;
}

export async function insertMessageLog(input: Omit<MessageLogRecord, "id" | "createdAtISO"> & { id?: string }): Promise<string> {
  const id = input.id ?? randomUUID();
  const createdAtISO = nowISO();
  await dbExec(
    `INSERT INTO message_logs(
      id, gmail_message_id, thread_id, direction, from_email, subject, body_text, classification, plan_json, decision_token, chosen_option, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      id,
      input.gmailMessageId ?? null,
      input.threadId ?? null,
      input.direction,
      input.fromEmail ?? null,
      input.subject ?? null,
      input.bodyText ?? null,
      input.classification ?? null,
      input.planJson ?? null,
      input.decisionToken ?? null,
      input.chosenOption ?? null,
      createdAtISO,
    ]
  );
  return id;
}

export async function getPendingDecisionForSender(fromEmail: string): Promise<MessageLogRecord | null> {
  const row = await dbGetOne<any>(
    `SELECT * FROM message_logs
     WHERE direction = 'out'
       AND from_email = ?
       AND decision_token IS NOT NULL
       AND (chosen_option IS NULL OR chosen_option = '')
     ORDER BY datetime(created_at) DESC
     LIMIT 1;`,
    [fromEmail]
  );
  if (!row) return null;
  return {
    id: String(row.id),
    gmailMessageId: row.gmail_message_id == null ? null : String(row.gmail_message_id),
    threadId: row.thread_id == null ? null : String(row.thread_id),
    direction: row.direction,
    fromEmail: row.from_email == null ? null : String(row.from_email),
    subject: row.subject == null ? null : String(row.subject),
    bodyText: row.body_text == null ? null : String(row.body_text),
    classification: row.classification == null ? null : String(row.classification),
    planJson: row.plan_json == null ? null : String(row.plan_json),
    decisionToken: row.decision_token == null ? null : String(row.decision_token),
    chosenOption: row.chosen_option == null ? null : String(row.chosen_option),
    createdAtISO: String(row.created_at),
  };
}

export async function getDecisionByToken(fromEmail: string, decisionToken: string): Promise<MessageLogRecord | null> {
  const row = await dbGetOne<any>(
    `SELECT * FROM message_logs
     WHERE direction = 'out'
       AND from_email = ?
       AND decision_token = ?
     ORDER BY datetime(created_at) DESC
     LIMIT 1;`,
    [fromEmail, decisionToken]
  );
  if (!row) return null;
  return {
    id: String(row.id),
    gmailMessageId: row.gmail_message_id == null ? null : String(row.gmail_message_id),
    threadId: row.thread_id == null ? null : String(row.thread_id),
    direction: row.direction,
    fromEmail: row.from_email == null ? null : String(row.from_email),
    subject: row.subject == null ? null : String(row.subject),
    bodyText: row.body_text == null ? null : String(row.body_text),
    classification: row.classification == null ? null : String(row.classification),
    planJson: row.plan_json == null ? null : String(row.plan_json),
    decisionToken: row.decision_token == null ? null : String(row.decision_token),
    chosenOption: row.chosen_option == null ? null : String(row.chosen_option),
    createdAtISO: String(row.created_at),
  };
}

export async function setDecisionChosen(decisionToken: string, chosenOption: string): Promise<void> {
  await dbExec(
    `UPDATE message_logs
     SET chosen_option = ?
     WHERE decision_token = ? AND direction = 'out';`,
    [chosenOption, decisionToken]
  );
}


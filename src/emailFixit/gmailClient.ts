import { gmail_v1, google } from "googleapis";

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} env var`);
  return v;
}

function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return Buffer.from(b64 + pad, "base64").toString("utf8");
}

function findHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string | null {
  const h = (headers ?? []).find((x) => (x.name ?? "").toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}

function extractEmailAddress(fromHeader: string | null): string | null {
  if (!fromHeader) return null;
  const m = fromHeader.match(/<([^>]+)>/);
  if (m) return m[1].trim();
  const simple = fromHeader.trim();
  return simple.includes("@") ? simple : null;
}

function findTextPlain(part?: gmail_v1.Schema$MessagePart): string | null {
  if (!part) return null;
  if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64Url(part.body.data);
  const parts = part.parts ?? [];
  for (const p of parts) {
    const v = findTextPlain(p);
    if (v) return v;
  }
  return null;
}

export interface GmailInboundMessage {
  id: string;
  threadId: string | null;
  fromEmail: string | null;
  subject: string | null;
  rfcMessageId: string | null;
  references: string | null;
  dateHeader: string | null;
  bodyText: string;
}

export function createGmailClient(): gmail_v1.Gmail {
  const clientId = getEnv("GMAIL_CLIENT_ID");
  const clientSecret = getEnv("GMAIL_CLIENT_SECRET");
  const refreshToken = getEnv("GMAIL_REFRESH_TOKEN");

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });

  return google.gmail({ version: "v1", auth: oauth2 });
}

export async function listUnreadFixitMessageIds(gmail: gmail_v1.Gmail, opts: { label: string; maxResults: number }) {
  const label = opts.label;
  const res = await gmail.users.messages.list({
    userId: "me",
    q: `is:unread label:${label}`,
    maxResults: opts.maxResults,
  });

  const msgs = res.data.messages ?? [];
  return msgs.map((m) => String(m.id));
}

export async function fetchMessage(gmail: gmail_v1.Gmail, id: string): Promise<GmailInboundMessage> {
  const res = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  const msg = res.data;
  const headers = msg.payload?.headers ?? [];

  const fromHeader = findHeader(headers, "From");
  const subject = findHeader(headers, "Subject");
  const rfcMessageId = findHeader(headers, "Message-ID") ?? findHeader(headers, "Message-Id");
  const references = findHeader(headers, "References");
  const dateHeader = findHeader(headers, "Date");

  const bodyText = (findTextPlain(msg.payload ?? undefined) ?? "").trim();

  return {
    id: String(msg.id),
    threadId: msg.threadId ? String(msg.threadId) : null,
    fromEmail: extractEmailAddress(fromHeader),
    subject: subject ?? null,
    rfcMessageId: rfcMessageId ?? null,
    references: references ?? null,
    dateHeader: dateHeader ?? null,
    bodyText,
  };
}

export async function markMessageRead(gmail: gmail_v1.Gmail, id: string): Promise<void> {
  await gmail.users.messages.modify({
    userId: "me",
    id,
    requestBody: { removeLabelIds: ["UNREAD"] },
  });
}


import nodemailer from "nodemailer";
import { google } from "googleapis";

export async function sendEmail(opts: {
  to: string;
  from: string;
  subject: string;
  text: string;
  threadId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
}) {
  const gmailUser = process.env.GMAIL_USER_EMAIL;
  const gmailClientId = process.env.GMAIL_CLIENT_ID;
  const gmailClientSecret = process.env.GMAIL_CLIENT_SECRET;
  const gmailRefreshToken = process.env.GMAIL_REFRESH_TOKEN;

  const canUseGmailOauth = Boolean(gmailUser && gmailClientId && gmailClientSecret && gmailRefreshToken);

  if (canUseGmailOauth) {
    await sendViaGmailApi({
      userEmail: gmailUser!,
      clientId: gmailClientId!,
      clientSecret: gmailClientSecret!,
      refreshToken: gmailRefreshToken!,
      to: opts.to,
      from: opts.from,
      subject: opts.subject,
      text: opts.text,
      threadId: opts.threadId ?? null,
      inReplyTo: opts.inReplyTo ?? null,
      references: opts.references ?? null,
    });
    return;
  }

  const transporter = createSmtpTransport();
  await transporter.sendMail({ from: opts.from, to: opts.to, subject: opts.subject, text: opts.text });
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function sendViaGmailApi(opts: {
  userEmail: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  to: string;
  from: string;
  subject: string;
  text: string;
  threadId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
}) {
  // We always send as the authenticated Gmail user for consistency.
  // (If you want aliases later, we can add explicit support.)
  const effectiveFrom = opts.userEmail;

  const oauth2 = new google.auth.OAuth2(opts.clientId, opts.clientSecret);
  oauth2.setCredentials({ refresh_token: opts.refreshToken });

  const gmail = google.gmail({ version: "v1", auth: oauth2 });

  const headers: string[] = [];
  headers.push(`From: ${effectiveFrom}`);
  headers.push(`To: ${opts.to}`);
  headers.push(`Subject: ${opts.subject}`);
  if (opts.inReplyTo) {
    headers.push(`In-Reply-To: ${wrapMessageId(opts.inReplyTo)}`);
    const refs = opts.references
      ? `${opts.references} ${wrapMessageId(opts.inReplyTo)}`
      : wrapMessageId(opts.inReplyTo);
    headers.push(`References: ${refs}`);
  }
  headers.push("MIME-Version: 1.0");
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push("Content-Transfer-Encoding: 7bit");

  const rawMessage = headers.join("\r\n") + "\r\n\r\n" + opts.text + "\r\n";

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: base64UrlEncode(rawMessage), ...(opts.threadId ? { threadId: opts.threadId } : {}) },
  });
}

function wrapMessageId(messageId: string): string {
  const v = String(messageId || "").trim();
  if (!v) return v;
  return v.startsWith("<") && v.endsWith(">") ? v : `<${v}>`;
}

function createSmtpTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host) throw new Error("Missing SMTP_HOST env var");
  if (!user) throw new Error("Missing SMTP_USER env var");
  if (!pass) throw new Error("Missing SMTP_PASS env var");

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}



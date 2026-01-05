import nodemailer from "nodemailer";

export async function sendEmail(opts: { to: string; from: string; subject: string; text: string }) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host) throw new Error("Missing SMTP_HOST env var");
  if (!user) throw new Error("Missing SMTP_USER env var");
  if (!pass) throw new Error("Missing SMTP_PASS env var");

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  await transporter.sendMail({
    from: opts.from,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
  });
}



// Outgoing email. Uses Resend if RESEND_API_KEY is set, otherwise SMTP
// (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS, e.g. Gmail with an app password).
// With neither configured, messages are only logged (local development).
import nodemailer from "nodemailer";
import { env } from "./util.mjs";

let transport;

export function mailConfigured() {
  return Boolean(env("RESEND_API_KEY") || env("SMTP_HOST"));
}

function fromAddress() {
  return env("MAIL_FROM") || (env("SMTP_USER") ? `MangoWorks3D <${env("SMTP_USER")}>` : "MangoWorks3D <mangoworks3d@gmail.com>");
}

export async function sendMail({ to, subject, text, replyTo }) {
  if (!to) return { skipped: true };
  if (env("RESEND_API_KEY")) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env("RESEND_API_KEY")}`, "content-type": "application/json" },
      body: JSON.stringify({ from: fromAddress(), to: [to], subject, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
    return { sent: true };
  }
  if (env("SMTP_HOST")) {
    const port = Number(env("SMTP_PORT", "465"));
    transport ||= nodemailer.createTransport({
      host: env("SMTP_HOST"),
      port,
      secure: port === 465,
      auth: { user: env("SMTP_USER"), pass: env("SMTP_PASS") },
    });
    await transport.sendMail({ from: fromAddress(), to, subject, text, ...(replyTo ? { replyTo } : {}) });
    return { sent: true };
  }
  console.log(`[mail not configured] To: ${to}\nSubject: ${subject}\n\n${text}`);
  return { logged: true };
}

// Never let a notification failure break the request that triggered it.
export async function trySendMail(msg) {
  try { return await sendMail(msg); } catch (e) { console.error("sendMail failed:", e); return { error: true }; }
}

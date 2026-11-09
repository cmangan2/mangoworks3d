// Email sign-in: a 6-digit code is emailed, verifying it creates a session cookie.
import crypto from "node:crypto";
import { stores, sha256, randomToken, normEmail, isEmail, parseCookies, isAdminEmail, HttpError, env } from "./util.mjs";
import { sendMail, mailConfigured } from "./mail.mjs";

const COOKIE = "mw_session";
const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_GAP_MS = 45 * 1000;
const MAX_TRIES = 5;
const MAX_CODES_PER_DAY = 8; // caps guessing: at most 8 codes × 5 tries per email per day
const SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

export async function startLogin(rawEmail, siteUrl) {
  const email = normEmail(rawEmail);
  if (!isEmail(email)) throw new HttpError(400, "Enter a valid email address.");
  const auth = stores.auth();
  const prev = await auth.get(`code:${email}`, { type: "json" });
  if (prev && Date.now() - prev.sentAt < RESEND_GAP_MS) {
    throw new HttpError(429, "A code was just sent. Wait a moment before asking for another.");
  }
  const day = new Date().toISOString().slice(0, 10);
  const sentToday = prev?.day === day ? prev.sentToday || 0 : 0;
  if (sentToday >= MAX_CODES_PER_DAY) throw new HttpError(429, "Too many sign-in codes today. Try again tomorrow, or email mangoworks3D@gmail.com.");
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  await auth.setJSON(`code:${email}`, { hash: sha256(`${email}:${code}`), exp: Date.now() + CODE_TTL_MS, tries: 0, sentAt: Date.now(), day, sentToday: sentToday + 1 });
  const devMode = env("MW_DEV_SHOW_CODE") === "1";
  if (!mailConfigured() && !devMode) {
    await auth.delete(`code:${email}`);
    throw new HttpError(503, "Sign-in emails aren't set up on the server yet (SMTP settings missing in Netlify, or the site wasn't redeployed after adding them).");
  }
  try {
    await sendMail({
      to: email,
      subject: `Your MangoWorks3D sign-in code: ${code}`,
      text: `Your MangoWorks3D sign-in code is ${code}\n\nIt expires in 10 minutes. If you didn't ask for it, you can ignore this email.\n\n${siteUrl}`,
    });
  } catch (e) {
    console.error("sign-in email failed:", e);
    await auth.setJSON(`code:${email}`, { ...(prev || {}), sentAt: 0, exp: 0, tries: MAX_TRIES, day, sentToday });
    throw new HttpError(502, `Couldn't send the sign-in email: ${describeMailError(e)}`);
  }
  // Local development without email: hand the code back so the flow can be tested.
  return env("MW_DEV_SHOW_CODE") === "1" && !mailConfigured() ? { devCode: code } : {};
}

export async function verifyLogin(rawEmail, rawCode) {
  const email = normEmail(rawEmail);
  const code = String(rawCode || "").replace(/\D/g, "");
  const auth = stores.auth();
  const rec = await auth.get(`code:${email}`, { type: "json" });
  if (!rec || rec.exp < Date.now()) throw new HttpError(400, "That code has expired. Request a new one.");
  if (rec.tries >= MAX_TRIES) throw new HttpError(429, "Too many attempts. Request a new code.");
  if (rec.hash !== sha256(`${email}:${code}`)) {
    await auth.setJSON(`code:${email}`, { ...rec, tries: rec.tries + 1 });
    throw new HttpError(400, "That code isn't right. Check the email and try again.");
  }
  // Keep the daily counter, drop the used code.
  await auth.setJSON(`code:${email}`, { day: rec.day, sentToday: rec.sentToday, sentAt: 0, exp: 0, tries: MAX_TRIES });

  const users = stores.users();
  const user = (await users.get(email, { type: "json" })) || { email, name: "", phone: "", created: new Date().toISOString() };
  user.lastLogin = new Date().toISOString();
  await users.setJSON(email, user);

  const token = randomToken();
  await auth.setJSON(`sess:${sha256(token)}`, { email, exp: Date.now() + SESSION_TTL_MS });
  return { token, user };
}

// Plain-English reason for a failed send (no secrets in these messages).
function describeMailError(e) {
  const code = e?.code || "";
  if (code === "EAUTH" || e?.responseCode === 535) return "the mail server rejected the username/password (check SMTP_USER and that SMTP_PASS is the 16-letter app password).";
  if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ENOTFOUND", "ECONNREFUSED"].includes(code)) return `couldn't connect to the mail server (check SMTP_HOST and SMTP_PORT). [${code}]`;
  return `${code || "error"}${e?.responseCode ? " " + e.responseCode : ""}.`;
}

export function sessionCookie(token, secure) {
  const attrs = [`${COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

// Returns { email, admin, user } for a signed-in request, or null.
export async function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const auth = stores.auth();
  const key = `sess:${sha256(token)}`;
  const sess = await auth.get(key, { type: "json" });
  if (!sess) return null;
  if (sess.exp < Date.now()) { await auth.delete(key); return null; }
  const user = (await stores.users().get(sess.email, { type: "json" })) || { email: sess.email };
  return { email: sess.email, admin: isAdminEmail(sess.email), user };
}

export async function logout(req) {
  const token = parseCookies(req)[COOKIE];
  if (token) await stores.auth().delete(`sess:${sha256(token)}`);
}

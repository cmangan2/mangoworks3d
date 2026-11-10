// Small shared helpers for the API function.
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

// Stores (Netlify Blobs). Strong consistency so a write is visible on the next read.
export const store = (name) => getStore({ name, consistency: "strong" });
export const stores = {
  auth: () => store("auth"),         // code:<email>, sess:<sha256(token)>
  users: () => store("users"),       // <email> -> profile
  requests: () => store("requests"), // <id> -> quote/order record
  files: () => store("files"),       // <requestId>/<n> -> small attachment (older requests)
  uploads: () => store("uploads"),   // chunked customer files, see uploads.mjs
  site: () => store("site"),         // materials, catalog, settings
  images: () => store("images"),     // <id> -> product photo
};

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

export const err = (status, message) => json({ error: message }, status);

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

// Short, readable reference IDs for requests: MW-7K3QF2 (no 0/O/1/I).
const ALPHA = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export function refId(prefix = "MW-", len = 6) {
  const b = crypto.randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHA[b[i] % ALPHA.length];
  return prefix + s;
}

export const normEmail = (e) => String(e || "").trim().toLowerCase();
// Deliberately strict: no quotes/brackets, so an address can never break out of HTML or JS.
export const isEmail = (e) => /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(e) && e.length <= 200;

// Trim strings and cap their length so stored records stay small.
export const clean = (v, max = 2000) => String(v ?? "").trim().slice(0, max);

export async function readJson(req) {
  try { return await req.json(); } catch { throw new HttpError(400, "Invalid JSON body"); }
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const env = (k, d = "") => (globalThis.Netlify?.env?.get(k) ?? process.env[k] ?? d);

// Admin accounts: ADMIN_EMAILS (comma-separated) in the Netlify environment.
export function adminEmails() {
  return env("ADMIN_EMAILS", "mangoworks3d@gmail.com")
    .split(",").map(normEmail).filter(Boolean);
}
export const isAdminEmail = (email) => adminEmails().includes(normEmail(email));

export const STATUSES = [
  { id: "new", label: "New" },
  { id: "reviewing", label: "Reviewing" },
  { id: "quoted", label: "Quote sent" },
  { id: "approved", label: "Approved" },
  { id: "printing", label: "Printing" },
  { id: "ready", label: "Ready to ship" },
  { id: "shipped", label: "Shipped" },
  { id: "completed", label: "Completed" },
  { id: "cancelled", label: "Cancelled" },
];
export const statusLabel = (id) => STATUSES.find((s) => s.id === id)?.label || id;

// Stripe Checkout for approved quotes, through Stripe's REST API (no SDK).
// Env: STRIPE_SECRET_KEY (required to turn payments on),
//      STRIPE_WEBHOOK_SECRET (optional but recommended: confirms payments even
//      if the customer closes the tab before returning to the site).
import crypto from "node:crypto";
import { env, HttpError } from "./util.mjs";

export const paymentsEnabled = () => Boolean(env("STRIPE_SECRET_KEY"));
const apiBase = () => env("STRIPE_API_BASE", "https://api.stripe.com"); // overridable for local tests

// "$1,234.50" / "From $12" / "25" -> cents (null when there's no usable amount).
export function parseAmountCents(price) {
  const m = String(price || "").replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const cents = Math.round(parseFloat(m[1]) * 100);
  return cents >= 50 ? cents : null; // Stripe's minimum charge is $0.50
}
export const fmtCents = (c) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

// Stripe takes form-encoded bodies with bracketed keys.
function formEncode(obj, prefix, out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && typeof v === "object") formEncode(v, key, out);
    else if (v !== undefined) out.append(key, String(v));
  }
  return out;
}

async function stripe(method, path, body) {
  const res = await fetch(`${apiBase()}/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${env("STRIPE_SECRET_KEY")}`, "content-type": "application/x-www-form-urlencoded" },
    body: body ? formEncode(body).toString() : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("Stripe error", res.status, data?.error);
    throw new HttpError(502, "The payment page couldn't be opened. Please try again, or reply to your quote email.");
  }
  return data;
}

// q = { subtotal, shipping } in cents. successUrl may contain {CHECKOUT_SESSION_ID}.
export async function createCheckout(r, q, successUrl, cancelUrl) {
  const line = (name, amount) => ({ quantity: 1, price_data: { currency: "usd", unit_amount: amount, product_data: { name } } });
  const lineItems = { 0: line(`MangoWorks3D order ${r.id}`, q.subtotal) };
  if (q.shipping > 0) lineItems[1] = line("Shipping", q.shipping);
  return stripe("POST", "/checkout/sessions", {
    mode: "payment",
    customer_email: r.email,
    client_reference_id: r.id,
    metadata: { requestId: r.id },
    payment_intent_data: { metadata: { requestId: r.id }, description: `MangoWorks3D ${r.id}` },
    line_items: lineItems,
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
}

export const getCheckout = (sessionId) => stripe("GET", `/checkout/sessions/${encodeURIComponent(sessionId)}`);

// Verify a webhook's Stripe-Signature header (HMAC-SHA256 of "t.body").
export function verifyWebhook(rawBody, header, toleranceSec = 300) {
  const secret = env("STRIPE_WEBHOOK_SECRET");
  if (!secret) throw new HttpError(400, "Webhook secret not configured");
  const parts = Object.fromEntries((header || "").split(",").map((p) => p.split("=")).filter((p) => p.length === 2).map(([k, v]) => [k, v]));
  const sigs = (header || "").split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length) throw new HttpError(400, "Bad signature header");
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) throw new HttpError(400, "Signature too old");
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const ok = sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) throw new HttpError(400, "Bad signature");
  return JSON.parse(rawBody);
}

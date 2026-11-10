// Quotes as line items + shipping, the shipping address, and the invoice view.
import { clean, randomToken, HttpError } from "./util.mjs";

// "$12.50" / "12" / "Free" / "" -> cents (0 allowed); null when it isn't a number.
export function parseMoneyCents(v) {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
  const s = String(v ?? "").trim();
  if (!s || /^free$/i.test(s)) return 0;
  const m = s.replace(/[,$\s]/g, "").match(/^(\d+(?:\.\d{1,2})?)$/);
  return m ? Math.round(parseFloat(m[1]) * 100) : null;
}

const MAX_CENTS = 10_000_000; // $100k sanity cap per line

// Admin sends { lines: [{ desc, qty, unit (cents) }], shipping (cents) }.
export function sanitizeQuote(body) {
  const lines = (Array.isArray(body?.lines) ? body.lines : []).slice(0, 50).map((l) => ({
    desc: clean(l?.desc, 200),
    qty: Math.max(1, Math.min(999, parseInt(l?.qty, 10) || 1)),
    unit: Math.min(MAX_CENTS, Math.max(0, parseInt(l?.unit, 10) || 0)),
  })).filter((l) => l.desc);
  const shipping = Math.min(MAX_CENTS, Math.max(0, parseInt(body?.shipping, 10) || 0));
  const subtotal = lines.reduce((s, l) => s + l.qty * l.unit, 0);
  return { lines, shipping, subtotal, total: subtotal + shipping };
}

// Old requests only have a free-text price; treat it as one line.
export function quoteOf(r, parseAmountCents) {
  if (r.quote?.lines?.length) return r.quote;
  const amount = parseAmountCents(r.price);
  if (!amount) return null;
  const desc = r.items?.length ? r.items.map((i) => `${i.name} × ${i.qty}`).join(", ") : "3D printing";
  return { lines: [{ desc, qty: 1, unit: amount }], shipping: 0, subtotal: amount, total: amount };
}

// Every order ships, so the request form always collects an address.
export function parseAddress(src, required = true) {
  const get = (k) => (typeof src.get === "function" ? src.get(k) : src?.[k]);
  const a = {
    line1: clean(get("ship_line1"), 120), line2: clean(get("ship_line2"), 120),
    city: clean(get("ship_city"), 80), state: clean(get("ship_state"), 60),
    zip: clean(get("ship_zip"), 20), country: clean(get("ship_country"), 60) || "United States",
  };
  if (required && (!a.line1 || !a.city || !a.state || !a.zip)) {
    throw new HttpError(400, "Please enter your shipping address (street, city, state and ZIP).");
  }
  return a;
}

export const addressLines = (a) => a ? [a.line1, a.line2, `${a.city}, ${a.state} ${a.zip}`.trim(), a.country !== "United States" ? a.country : ""].filter(Boolean) : [];

// A secret link token so customers can open their invoice from the email without signing in.
export function ensureViewToken(r) {
  r.viewToken ||= randomToken(16);
  return r.viewToken;
}

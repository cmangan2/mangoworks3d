// MangoWorks3D API: one function serving /api/* (accounts, quotes/orders, admin).
import {
  stores, json, err, HttpError, readJson, normEmail, isEmail, clean, refId, randomToken,
  STATUSES, statusLabel, isAdminEmail,
} from "../lib/util.mjs";
import { startLogin, verifyLogin, currentUser, sessionCookie, clearCookie, logout } from "../lib/auth.mjs";
import { trySendMail } from "../lib/mail.mjs";
import { startUpload, putChunk, attachUploads, getChunk, deleteUpload } from "../lib/uploads.mjs";
import { paymentsEnabled, parseAmountCents, fmtCents, createCheckout, getCheckout, verifyWebhook } from "../lib/stripe.mjs";
import { sanitizeQuote, quoteOf, parseAddress, addressLines, ensureViewToken, parseMoneyCents } from "../lib/quote.mjs";
import {
  getMaterials, getCatalog, getSettings, sanitizeMaterials, sanitizeCatalog, sanitizeSettings,
} from "../lib/site.mjs";

export const config = { path: "/api/*" };

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;  // direct form attachments (older pages); big files use /uploads
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;   // product photo (the admin page shrinks photos first)
const STATUS_IDS = new Set(STATUSES.map((s) => s.id));

export default async function handler(req) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, "").replace(/\/+$/, "") || "/";
  const method = req.method;
  try {
    if (method !== "GET" && method !== "HEAD") checkOrigin(req, url);
    const route = routes.find((r) => r.method === method && r.re.test(path));
    if (!route) return err(404, "Not found");
    const params = path.match(route.re).slice(1).map(decodeURIComponent);
    return await route.fn({ req, url, params });
  } catch (e) {
    if (e instanceof HttpError) return err(e.status, e.message);
    console.error(e);
    return err(500, "Something went wrong on our side. Please try again.");
  }
}

// Cookies are SameSite=Lax; also refuse cross-site writes outright.
function checkOrigin(req, url) {
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== url.host) throw new HttpError(400, "Cross-site request refused");
}

const siteUrl = (url) => `${url.protocol}//${url.host}`;

async function requireUser(req) {
  const u = await currentUser(req);
  if (!u) throw new HttpError(401, "Please sign in.");
  return u;
}
async function requireAdmin(req) {
  const u = await requireUser(req);
  if (!u.admin) throw new HttpError(401, "Admins only.");
  return u;
}

// What a customer may see of their own request (no internal note).
const publicRequest = ({ adminNote, ...r }) => r;

async function listRequests(filterEmail) {
  const reqs = stores.requests();
  let keys;
  if (filterEmail) {
    const { blobs } = await reqs.list({ prefix: `by-email/${filterEmail}/` });
    keys = blobs.map((b) => b.key.split("/").pop());
  } else {
    const { blobs } = await reqs.list({ prefix: "req/" });
    keys = blobs.map((b) => b.key.slice(4));
  }
  const rows = await Promise.all(keys.map((id) => reqs.get(`req/${id}`, { type: "json" })));
  return rows.filter(Boolean).sort((a, b) => b.created.localeCompare(a.created));
}

async function getRequest(id) {
  const r = await stores.requests().get(`req/${id}`, { type: "json" });
  if (!r) throw new HttpError(404, "Request not found");
  return r;
}
const saveRequest = (r) => stores.requests().setJSON(`req/${r.id}`, r);

function requestSummary(r) {
  const lines = [
    `Reference: ${r.id}`,
    `Type: ${r.kind === "order" ? "Shop order" : "Quote request"}`,
    `Name: ${r.name}`, `Email: ${r.email}`, `Phone: ${r.phone || "-"}`,
    `Service: ${r.service || "-"}`, `Material: ${r.material || "-"}`, `Color: ${r.color || "-"}`,
  ];
  if (r.items?.length) lines.push("", "Items:", ...r.items.map((i) => `  • ${i.name} — ${i.material}, ${i.color}, qty ${i.qty}`));
  if (r.files?.length) lines.push("", "Files:", ...r.files.map((f) => `  • ${f.name} (${Math.round(f.size / 1024)} KB)`));
  if (r.shipTo) lines.push("", "Ship to:", ...addressLines(r.shipTo).map((l) => `  ${l}`));
  lines.push("", r.message || "");
  return lines.join("\n");
}

const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern}$`), fn });

// ── Public ──────────────────────────────────────────────────────────────
route("GET", "/site", async () => {
  const [materials, catalog, settings] = await Promise.all([getMaterials(), getCatalog(), getSettings()]);
  const { notifyEmail, ...publicSettings } = settings;
  return json({
    materials,
    catalog: { items: catalog.items.filter((p) => p.active !== false) },
    settings: publicSettings,
    statuses: STATUSES,
    payments: paymentsEnabled(),
  });
});

route("GET", "/img/([\\w-]+)", async ({ params: [id] }) => {
  const res = await stores.images().getWithMetadata(id, { type: "arrayBuffer" });
  if (!res) return new Response("Not found", { status: 404 });
  return new Response(res.data, {
    headers: { "content-type": res.metadata?.type || "image/jpeg", "cache-control": "public, max-age=31536000, immutable" },
  });
});

// ── Sign-in ─────────────────────────────────────────────────────────────
route("POST", "/auth/start", async ({ req, url }) => {
  const { email } = await readJson(req);
  return json({ ok: true, ...(await startLogin(email, siteUrl(url))) });
});

route("POST", "/auth/verify", async ({ req, url }) => {
  const { email, code } = await readJson(req);
  const { token, user } = await verifyLogin(email, code);
  // First sign-in after ordering as a guest: take name/phone from their latest request.
  if (!user.name || !user.phone || !user.address) {
    const [latest] = await listRequests(user.email);
    if (latest) {
      user.name ||= latest.name; user.phone ||= latest.phone; user.address ||= latest.shipTo || null;
      await stores.users().setJSON(user.email, user);
    }
  }
  const me = { signedIn: true, email: user.email, name: user.name || "", phone: user.phone || "", address: user.address || null, admin: isAdminEmail(user.email) };
  return json(me, 200, { "set-cookie": sessionCookie(token, url.protocol === "https:") });
});

route("POST", "/auth/logout", async ({ req }) => {
  await logout(req);
  return json({ ok: true }, 200, { "set-cookie": clearCookie() });
});

route("GET", "/auth/me", async ({ req }) => {
  const u = await currentUser(req);
  if (!u) return json({ signedIn: false });
  return json({ signedIn: true, email: u.email, name: u.user.name || "", phone: u.user.phone || "", address: u.user.address || null, admin: u.admin });
});

route("PATCH", "/me", async ({ req }) => {
  const u = await requireUser(req);
  const body = await readJson(req);
  const user = { ...u.user, email: u.email, name: clean(body.name, 100), phone: clean(body.phone, 40) };
  await stores.users().setJSON(u.email, user);
  return json({ ok: true });
});

// ── Customer requests ───────────────────────────────────────────────────
route("POST", "/requests", async ({ req, url }) => {
  const form = await req.formData();
  if (clean(form.get("website"))) return json({ ok: true, id: "MW-OK" }); // honeypot: bots fill every field

  const me = await currentUser(req);
  const email = me?.email || normEmail(form.get("email"));
  const name = clean(form.get("name"), 100);
  if (!name || !isEmail(email)) throw new HttpError(400, "Please enter your name and a valid email.");
  const message = clean(form.get("message"), 5000);
  let items = [];
  try { items = JSON.parse(form.get("items") || "[]"); } catch {}
  items = (Array.isArray(items) ? items : []).slice(0, 50).map((i) => ({
    name: clean(i?.name, 120), material: clean(i?.material, 60), color: clean(i?.color, 120),
    qty: Math.max(1, Math.min(999, parseInt(i?.qty, 10) || 1)), productId: clean(i?.productId, 40),
    price: clean(i?.price, 40),
    // Only our own product photos (shown as thumbnails in the account and admin pages).
    image: /^\/api\/img\/[\w-]+$/.test(i?.image || "") ? i.image : "",
  })).filter((i) => i.name);
  if (!message && !items.length) throw new HttpError(400, "Please describe your project.");

  const shipTo = parseAddress(form);
  const id = refId();
  const files = [];
  const uploads = form.getAll("attachment").filter((f) => f && typeof f === "object" && f.size > 0);
  let total = 0;
  for (const f of uploads.slice(0, 5)) {
    total += f.size;
    if (total > MAX_UPLOAD_BYTES) throw new HttpError(413, "Files are too big to upload here (5 MB max). Email them to mangoworks3D@gmail.com or paste a share link in the description.");
    const n = files.length;
    const meta = { name: clean(f.name, 200) || `file-${n + 1}`, type: f.type || "application/octet-stream", size: f.size };
    await stores.files().set(`${id}/${n}`, await f.arrayBuffer(), { metadata: meta });
    files.push({ n, ...meta });
  }
  let uploadIds = [];
  try { uploadIds = JSON.parse(form.get("uploads") || "[]"); } catch {}
  for (const f of await attachUploads(uploadIds, id)) files.push({ n: files.length, ...f });

  const now = new Date().toISOString();
  const record = {
    id, kind: items.length ? "order" : "quote", created: now, updated: now,
    email, name, phone: clean(form.get("phone"), 40),
    service: clean(form.get("service"), 100), material: clean(form.get("material"), 60), color: clean(form.get("color"), 100),
    message, items, files, shipTo,
    status: "new", price: "", customerMessage: "", adminNote: "",
    history: [{ at: now, status: "new", by: "customer" }],
  };
  await saveRequest(record);
  await stores.requests().set(`by-email/${email}/${id}`, "");

  // Remember name/phone/address on the account so the form prefills next time.
  const users = stores.users();
  const user = await users.get(email, { type: "json" });
  if (user) await users.setJSON(email, { ...user, name: user.name || name, phone: user.phone || record.phone, address: shipTo });

  const settings = await getSettings();
  const site = siteUrl(url);
  await Promise.all([
    trySendMail({
      to: settings.notifyEmail,
      replyTo: email,
      subject: `New ${record.kind === "order" ? "order" : "quote request"} ${id} from ${name}`,
      text: `${requestSummary(record)}\n\nManage it: ${site}/admin/#${id}`,
    }),
    trySendMail({
      to: email,
      subject: `We got your request (${id})`,
      text: `Hi ${name},\n\nThanks for reaching out to MangoWorks3D! Your request ${id} is in, and we'll get back to you with a quote within 24–48 hours.\n\nTrack it any time: sign in at ${site}/account with this email address.\n\n— MangoWorks3D`,
    }),
  ]);
  return json({ ok: true, id });
});

route("GET", "/my/requests", async ({ req }) => {
  const u = await requireUser(req);
  return json({ items: (await listRequests(u.email)).map(publicRequest) });
});

// The customer's request: signed in as its owner, or holding the invoice link's token.
async function customerRequest(req, id, token) {
  const r = await getRequest(id);
  if (token && r.viewToken && token === r.viewToken) return r;
  const u = await currentUser(req);
  if (u && (u.email === r.email || u.admin)) return r;
  throw new HttpError(404, "Request not found");
}

const invoiceUrl = (r, site) => `${site}/invoice/?id=${encodeURIComponent(r.id)}&t=${ensureViewToken(r)}`;

// What the invoice page shows (no private notes, files or history).
async function invoiceView(r) {
  const q = quoteOf(r, parseAmountCents);
  return {
    id: r.id, kind: r.kind, created: r.created, quotedAt: r.quote?.updated || r.updated,
    name: r.name, email: r.email, phone: r.phone, shipTo: r.shipTo || null,
    items: r.items || [], quote: q, customerMessage: r.customerMessage,
    status: r.status, statusLabel: statusLabel(r.status), paid: r.paid || null,
    payable: Boolean(paymentsEnabled() && q?.total >= 50 && !r.paid && PAYABLE.has(r.status)),
    canApprove: r.status === "quoted" && !paymentsEnabled(),
    business: { name: "MangoWorks3D", email: "mangoworks3D@gmail.com" },
  };
}

route("GET", "/invoice/([\\w-]+)", async ({ req, url, params: [id] }) => {
  const r = await customerRequest(req, id, url.searchParams.get("t"));
  return json(await invoiceView(r));
});

route("POST", "/invoice/([\\w-]+)/(approve|checkout|confirm)", async ({ req, url, params: [id, action] }) => {
  const body = await readJson(req);
  const r = await customerRequest(req, id, body.t);
  const site = siteUrl(url);
  if (action === "approve") await approveRequest(r, site);
  else if (action === "confirm") await confirmCheckout(r, body.session, site);
  else {
    const back = invoiceUrl(r, site);
    return json(await startCheckout(r, `${back}&paid=1&session={CHECKOUT_SESSION_ID}`, back));
  }
  return json(await invoiceView(r));
});

// Approving without paying is only for when online payment is off (before Stripe is set up).
async function approveRequest(r, site) {
  if (r.status !== "quoted") throw new HttpError(409, "This request isn't waiting for your approval.");
  if (paymentsEnabled()) throw new HttpError(409, "Please approve the quote by paying online.");
  const now = new Date().toISOString();
  r.status = "approved"; r.updated = now;
  r.history.push({ at: now, status: "approved", by: "customer" });
  await saveRequest(r);
  const settings = await getSettings();
  await trySendMail({
    to: settings.notifyEmail, replyTo: r.email,
    subject: `Quote ${r.id} approved by ${r.name}`,
    text: `${r.name} approved the quote${r.price ? ` (${r.price})` : ""} for ${r.id} and will pay separately.\n\n${site}/admin/#${r.id}`,
  });
}

async function startCheckout(r, successUrl, cancelUrl) {
  if (!paymentsEnabled()) throw new HttpError(409, "Online payment isn't available yet. Reply to your quote email to arrange payment.");
  if (r.paid) throw new HttpError(409, "This order is already paid. Thank you!");
  if (!PAYABLE.has(r.status)) throw new HttpError(409, "This request isn't ready for payment.");
  const q = quoteOf(r, parseAmountCents);
  if (!q || q.total < 50) throw new HttpError(409, "This quote doesn't have a price to pay yet.");
  const session = await createCheckout(r, q, successUrl, cancelUrl);
  r.checkout = { sessionId: session.id, amount: q.total, at: new Date().toISOString() };
  await saveRequest(r);
  return { url: session.url };
}

// The customer is back from Stripe: confirm with Stripe before believing it.
async function confirmCheckout(r, sessionId, site) {
  if (r.paid || !sessionId || !paymentsEnabled()) return;
  const s = await getCheckout(String(sessionId));
  if (s.client_reference_id === r.id && s.payment_status === "paid") {
    await markPaid(r, { amount: s.amount_total, method: "card", sessionId: s.id, paymentIntent: s.payment_intent || "", by: "customer" }, site);
  }
}

route("POST", "/my/requests/([\\w-]+)/approve", async ({ req, url, params: [id] }) => {
  const u = await requireUser(req);
  const r = await getRequest(id);
  if (r.email !== u.email) throw new HttpError(404, "Request not found");
  await approveRequest(r, siteUrl(url));
  return json(publicRequest(r));
});

// ── Payments (Stripe Checkout) ──────────────────────────────────────────
const PAYABLE = new Set(["quoted", "approved"]);

// Record a payment once (webhook and the customer's return can both report it).
async function markPaid(r, { amount, method, sessionId = "", paymentIntent = "", by, receipt = false }, site) {
  if (r.paid && (!sessionId || r.paid.sessionId === sessionId)) return r;
  const now = new Date().toISOString();
  ensureViewToken(r);
  r.paid = { amount, method, at: now, by, sessionId, paymentIntent };
  if (r.status === "quoted") r.status = "approved";
  r.history.push({ at: now, status: r.status, by: `${by} — paid ${fmtCents(amount)} (${method})` });
  r.updated = now;
  await saveRequest(r);
  const settings = await getSettings();
  if (method === "card" || receipt) {
    await trySendMail({
      to: r.email, replyTo: settings.notifyEmail,
      subject: `Receipt for ${r.id}: ${fmtCents(amount)} paid`,
      text: `Hi ${r.name},\n\nThanks! We received your payment of ${fmtCents(amount)} for ${r.id}. We'll keep you posted as it's printed and shipped.\n\nYour receipt: ${invoiceUrl(r, site)}\n\n— MangoWorks3D`,
    });
  }
  if (method === "card") {
    await trySendMail({
      to: settings.notifyEmail, replyTo: r.email,
      subject: `Payment received: ${fmtCents(amount)} for ${r.id} (${r.name})`,
      text: `${r.name} paid ${fmtCents(amount)} by card for ${r.id}. The quote is now approved.

${site}/admin/#${r.id}`,
    });
  }
  return r;
}

route("POST", "/my/requests/([\\w-]+)/checkout", async ({ req, url, params: [id] }) => {
  const u = await requireUser(req);
  const r = await getRequest(id);
  if (r.email !== u.email) throw new HttpError(404, "Request not found");
  const site = siteUrl(url);
  return json(await startCheckout(r, `${site}/account?paid=${encodeURIComponent(r.id)}&session={CHECKOUT_SESSION_ID}`, `${site}/account`));
});

// The customer is back from Stripe: confirm with Stripe before believing it.
route("POST", "/my/requests/([\\w-]+)/confirm", async ({ req, url, params: [id] }) => {
  const u = await requireUser(req);
  const r = await getRequest(id);
  if (r.email !== u.email) throw new HttpError(404, "Request not found");
  const { session: sessionId } = await readJson(req);
  await confirmCheckout(r, sessionId, siteUrl(url));
  return json(publicRequest(r));
});

// Stripe → us. Set the endpoint to https://<site>/api/stripe/webhook, event checkout.session.completed.
route("POST", "/stripe/webhook", async ({ req, url }) => {
  const event = verifyWebhook(await req.text(), req.headers.get("stripe-signature"));
  const s = event.data?.object;
  if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type) && s?.payment_status === "paid") {
    const id = s.metadata?.requestId || s.client_reference_id;
    const r = id && (await stores.requests().get(`req/${id}`, { type: "json" }));
    if (r) await markPaid(r, { amount: s.amount_total, method: "card", sessionId: s.id, paymentIntent: s.payment_intent || "", by: "customer" }, siteUrl(url));
  }
  return json({ received: true });
});

// Chunked uploads (anyone filling in the form; ids are unguessable, unsubmitted ones expire).
route("POST", "/uploads", async ({ req }) => json(await startUpload(await readJson(req))));

route("PUT", "/uploads/([\\w-]+)/(\\d+)", async ({ req, params: [id, i] }) =>
  json(await putChunk(id, i, await req.arrayBuffer())));

route("GET", "/files/([\\w-]+)/(\\d+)", async ({ req, url, params: [id, n] }) => {
  const u = await requireUser(req);
  const r = await getRequest(id);
  if (!u.admin && r.email !== u.email) throw new HttpError(404, "Not found");
  const f = (r.files || []).find((x) => String(x.n) === n);
  if (f?.upload) {
    // Chunked file: ?part=i returns one piece; a one-piece file downloads directly.
    const part = url.searchParams.get("part");
    if (part === null && f.chunks > 1) throw new HttpError(400, "Download this file in parts (?part=0…).");
    const data = await getChunk(f.upload, part ?? 0);
    if (!data) throw new HttpError(404, "File not found");
    const name = f.name.replace(/["\\\r\n]/g, "_");
    return new Response(data, { headers: {
      "content-type": "application/octet-stream",
      ...(part === null ? { "content-disposition": `attachment; filename="${name}"` } : {}),
      "cache-control": "private, no-store",
    } });
  }
  const res = await stores.files().getWithMetadata(`${id}/${n}`, { type: "arrayBuffer" });
  if (!res) throw new HttpError(404, "File not found");
  const name = (res.metadata?.name || "file").replace(/["\\\r\n]/g, "_");
  return new Response(res.data, {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "private, no-store",
    },
  });
});

// ── Admin ───────────────────────────────────────────────────────────────
route("GET", "/admin/requests", async ({ req }) => {
  await requireAdmin(req);
  return json({ items: await listRequests(), statuses: STATUSES });
});

route("PATCH", "/admin/requests/([\\w-]+)", async ({ req, url, params: [id] }) => {
  const admin = await requireAdmin(req);
  const body = await readJson(req);
  const r = await getRequest(id);
  const now = new Date().toISOString();
  const prevStatus = r.status;
  if (body.status !== undefined) {
    if (!STATUS_IDS.has(body.status)) throw new HttpError(400, "Unknown status");
    if (body.status !== r.status) { r.status = body.status; r.history.push({ at: now, status: r.status, by: admin.email }); }
  }
  if (body.price !== undefined) r.price = clean(body.price, 60);
  if (body.quote !== undefined) {
    const q = sanitizeQuote(body.quote);
    r.quote = { ...q, updated: now };
    r.price = q.lines.length ? fmtCents(q.total) : "";
    ensureViewToken(r);
  }
  if (body.shipTo !== undefined) r.shipTo = parseAddress(body.shipTo, false);
  if (body.customerMessage !== undefined) r.customerMessage = clean(body.customerMessage, 3000);
  if (body.adminNote !== undefined) r.adminNote = clean(body.adminNote, 5000);
  if (body.paid === null && r.paid) {
    r.history.push({ at: now, status: r.status, by: `${admin.email} — marked unpaid` });
    delete r.paid;
  } else if (body.paid && !r.paid) {
    const amount = body.paid.amount !== undefined ? parseMoneyCents(body.paid.amount) : quoteOf(r, parseAmountCents)?.total;
    if (!amount) throw new HttpError(400, "Set a price first, or enter the amount received.");
    const method = clean(body.paid.method, 30) || "other";
    await markPaid(r, { amount, method, by: admin.email, receipt: Boolean(body.notify) }, siteUrl(url));
  }
  r.updated = now;
  await saveRequest(r);

  if (body.notify) {
    const site = siteUrl(url);
    const q = quoteOf(r, parseAmountCents);
    const lines = [`Hi ${r.name},`, ""];
    if (r.status === "quoted" && q) {
      lines.push(`Your quote ${r.id} from MangoWorks3D is ready:`, "");
      for (const l of q.lines) lines.push(`  ${l.desc}${l.qty > 1 ? ` × ${l.qty}` : ""}  —  ${fmtCents(l.qty * l.unit)}`);
      lines.push(`  Shipping  —  ${q.shipping ? fmtCents(q.shipping) : "Free"}`, `  Total  —  ${fmtCents(q.total)}`);
    } else {
      lines.push(`Update on your MangoWorks3D request ${r.id}: ${statusLabel(r.status)}.`);
    }
    if (r.customerMessage) lines.push("", r.customerMessage);
    if (r.status === "quoted" && q) {
      lines.push("", paymentsEnabled() && q.total >= 50
        ? `View your quote, approve and pay securely online here:\n${invoiceUrl(r, site)}`
        : `View and approve your quote here:\n${invoiceUrl(r, site)}`);
    } else if (q) {
      lines.push("", `Your invoice: ${invoiceUrl(r, site)}`);
    } else {
      lines.push("", `See the details any time at ${site}/account.`);
    }
    await saveRequest(r); // keeps the invoice link token
    lines.push("", "— MangoWorks3D");
    const settings = await getSettings();
    const sent = await trySendMail({ to: r.email, replyTo: settings.notifyEmail, subject: `${r.id}: ${statusLabel(r.status)}`, text: lines.join("\n") });
    return json({ ...r, notified: !sent.error, statusChanged: prevStatus !== r.status });
  }
  return json(r);
});

route("DELETE", "/admin/requests/([\\w-]+)", async ({ req, params: [id] }) => {
  await requireAdmin(req);
  const r = await getRequest(id);
  const reqs = stores.requests();
  await Promise.all([
    reqs.delete(`req/${id}`),
    reqs.delete(`by-email/${r.email}/${id}`),
    ...(r.files || []).map((f) => (f.upload ? deleteUpload(f.upload) : stores.files().delete(`${id}/${f.n}`))),
  ]);
  return json({ ok: true });
});

route("GET", "/admin/site", async ({ req }) => {
  await requireAdmin(req);
  const [materials, catalog, settings] = await Promise.all([getMaterials(), getCatalog(), getSettings()]);
  return json({ materials, catalog, settings });
});

route("PUT", "/admin/materials", async ({ req }) => {
  await requireAdmin(req);
  const data = sanitizeMaterials(await readJson(req));
  if (!data.items.length) throw new HttpError(400, "Keep at least one material.");
  await stores.site().setJSON("materials", data);
  return json(data);
});

route("PUT", "/admin/catalog", async ({ req }) => {
  await requireAdmin(req);
  const data = sanitizeCatalog(await readJson(req));
  await stores.site().setJSON("catalog", data);
  return json(data);
});

route("PUT", "/admin/settings", async ({ req }) => {
  await requireAdmin(req);
  const data = sanitizeSettings(await readJson(req));
  await stores.site().setJSON("settings", data);
  return json(await getSettings());
});

route("POST", "/admin/images", async ({ req }) => {
  await requireAdmin(req);
  const type = (req.headers.get("content-type") || "").split(";")[0];
  if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) throw new HttpError(415, "Upload a JPEG, PNG, WebP or GIF image.");
  const data = await req.arrayBuffer();
  if (data.byteLength > MAX_IMAGE_BYTES) throw new HttpError(413, "Image is too large (4 MB max).");
  const id = randomToken(12);
  await stores.images().set(id, data, { metadata: { type } });
  return json({ id, url: `/api/img/${id}` });
});

route("DELETE", "/admin/images/([\\w-]+)", async ({ req, params: [id] }) => {
  await requireAdmin(req);
  await stores.images().delete(id);
  return json({ ok: true });
});

route("GET", "/admin/customers", async ({ req }) => {
  await requireAdmin(req);
  const users = stores.users();
  const { blobs } = await users.list();
  const [rows, requests] = await Promise.all([
    Promise.all(blobs.map((b) => users.get(b.key, { type: "json" }))),
    listRequests(),
  ]);
  const counts = {};
  for (const r of requests) counts[r.email] = (counts[r.email] || 0) + 1;
  // Include people who submitted requests without ever signing in.
  const byEmail = new Map(rows.filter(Boolean).map((u) => [u.email, { ...u, account: true }]));
  for (const r of requests) if (!byEmail.has(r.email)) byEmail.set(r.email, { email: r.email, name: r.name, phone: r.phone, account: false });
  const items = [...byEmail.values()].map((u) => ({ ...u, requests: counts[u.email] || 0 }))
    .sort((a, b) => (b.lastLogin || b.created || "").localeCompare(a.lastLogin || a.created || ""));
  return json({ items });
});

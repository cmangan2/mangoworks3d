// Site content edited from /admin: materials & colors, stock products, settings.
import { stores } from "./util.mjs";

export const DEFAULT_MATERIALS = {
  items: [
    { name: "PLA", colors: [
      { name: "White", hex: "#F5F5F0" }, { name: "Black", hex: "#1C1C1C" }, { name: "Mango Orange", hex: "#FF8C00" },
      { name: "Red", hex: "#E63946" }, { name: "Blue", hex: "#2196F3" }, { name: "Teal", hex: "#00C9A7" },
      { name: "Green", hex: "#8BC34A" }, { name: "Yellow", hex: "#FFD700" } ] },
    { name: "ABS", colors: [ { name: "White", hex: "#F5F5F0" }, { name: "Black", hex: "#1C1C1C" }, { name: "Gray", hex: "#888888" } ] },
    { name: "PETG", colors: [ { name: "White", hex: "#F5F5F0" }, { name: "Black", hex: "#1C1C1C" }, { name: "Blue", hex: "#2196F3" }, { name: "Red", hex: "#E63946" } ] },
    { name: "ASA", colors: [ { name: "White", hex: "#F5F5F0" }, { name: "Black", hex: "#1C1C1C" } ] },
    { name: "TPU AMS", colors: [ { name: "Black", hex: "#1C1C1C" }, { name: "White", hex: "#F5F5F0" }, { name: "Mango Orange", hex: "#FF8C00" } ] },
    { name: "TPU 95A HF", colors: [ { name: "Black", hex: "#1C1C1C" }, { name: "White", hex: "#F5F5F0" }, { name: "Mango Orange", hex: "#FF8C00" } ] },
  ],
};

export const DEFAULT_SETTINGS = {
  announcement: "",               // banner across the top of the site; empty = hidden
  heroBadge: "Based in New Hampshire",
  stockNote: "These materials and colors are in stock. For custom jobs we can order any Bambu Lab filament (preferred) or other brands — just tell us what you need.", // materials popup, quote form, shop
  buildNote: "Build volume is about 10″ × 10″ × 10″ (256 mm). Need something bigger? We can print larger parts by splitting them into pieces with connecting features.", // printer popup, quote form
  notifyEmail: "mangoworks3d@gmail.com", // where new-request alerts go
};

export async function getMaterials() {
  return (await stores.site().get("materials", { type: "json" })) || DEFAULT_MATERIALS;
}
export async function getCatalog() {
  return (await stores.site().get("catalog", { type: "json" })) || { items: [] };
}
export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...((await stores.site().get("settings", { type: "json" })) || {}) };
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const s = (v, max) => String(v ?? "").trim().slice(0, max);

export function sanitizeMaterials(body) {
  const items = (Array.isArray(body?.items) ? body.items : []).slice(0, 50).map((m) => ({
    name: s(m?.name, 60),
    colors: (Array.isArray(m?.colors) ? m.colors : []).slice(0, 60)
      .map((c) => ({ name: s(c?.name, 40), hex: HEX.test(c?.hex) ? c.hex.toUpperCase() : "#888888" }))
      .filter((c) => c.name),
  })).filter((m) => m.name);
  return { items };
}

export function sanitizeCatalog(body) {
  const items = (Array.isArray(body?.items) ? body.items : []).slice(0, 200).map((p) => ({
    id: s(p?.id, 40).replace(/[^\w-]/g, "") || Math.random().toString(36).slice(2, 10),
    name: s(p?.name, 100),
    desc: s(p?.desc, 1500),
    price: s(p?.price, 40),
    emoji: s(p?.emoji, 8),
    images: (Array.isArray(p?.images) ? p.images : []).map((x) => s(x, 40).replace(/[^\w-]/g, "")).filter(Boolean).slice(0, 12),
    active: p?.active !== false,
  })).filter((p) => p.name);
  return { items };
}

export function sanitizeSettings(body) {
  return {
    announcement: s(body?.announcement, 300),
    heroBadge: s(body?.heroBadge, 60),
    stockNote: s(body?.stockNote, 400),
    buildNote: s(body?.buildNote, 400),
    notifyEmail: s(body?.notifyEmail, 200),
  };
}

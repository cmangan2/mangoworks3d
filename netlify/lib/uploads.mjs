// Large customer files (e.g. STEP) are uploaded in pieces, because a Netlify
// Function request or response tops out around 6 MB. The browser sends 3 MB
// chunks, the quote form then attaches the finished upload to its request, and
// downloads fetch the chunks back and join them in the browser.
//
// Store "uploads":  meta/<id> -> { name, type, size, chunks, created, requestId? }
//                   chunk/<id>/<i> -> bytes
import { stores, randomToken, clean, HttpError } from "./util.mjs";

export const CHUNK_BYTES = 3 * 1024 * 1024;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_FILES = 5;
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000; // never-submitted uploads are deleted after this

const store = () => stores.uploads();
const chunkCount = (size) => Math.max(1, Math.ceil(size / CHUNK_BYTES));

export async function startUpload({ name, size, type }) {
  size = Number(size);
  if (!Number.isFinite(size) || size <= 0) throw new HttpError(400, "That file is empty.");
  if (size > MAX_FILE_BYTES) throw new HttpError(413, `Files can be up to ${MAX_FILE_BYTES / 1024 / 1024} MB. For bigger files, paste a share link in the description.`);
  const id = randomToken(16);
  const meta = {
    name: clean(name, 200) || "file", type: clean(type, 100) || "application/octet-stream",
    size, chunks: chunkCount(size), created: Date.now(),
  };
  await store().setJSON(`meta/${id}`, meta);
  return { id, chunkSize: CHUNK_BYTES, chunks: meta.chunks };
}

export async function putChunk(id, index, data) {
  const meta = await store().get(`meta/${id}`, { type: "json" });
  if (!meta) throw new HttpError(404, "Upload not found (it may have expired). Please try again.");
  if (meta.requestId) throw new HttpError(409, "This upload is already attached to a request.");
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= meta.chunks) throw new HttpError(400, "Bad chunk number");
  const expected = i < meta.chunks - 1 ? CHUNK_BYTES : meta.size - CHUNK_BYTES * (meta.chunks - 1);
  if (data.byteLength !== expected) throw new HttpError(400, `Chunk ${i} has the wrong size.`);
  await store().set(`chunk/${id}/${i}`, data);
  return { ok: true };
}

// Validate finished uploads and claim them for a request. Returns file records.
export async function attachUploads(ids, requestId) {
  ids = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x).replace(/[^\w-]/g, "")).filter(Boolean))];
  if (ids.length > MAX_FILES) throw new HttpError(400, `Attach at most ${MAX_FILES} files.`);
  const files = [];
  let total = 0;
  for (const id of ids) {
    const meta = await store().get(`meta/${id}`, { type: "json" });
    if (!meta || meta.requestId) throw new HttpError(400, "A file upload went missing. Please attach it again.");
    const { blobs } = await store().list({ prefix: `chunk/${id}/` });
    if (blobs.length !== meta.chunks) throw new HttpError(400, `“${meta.name}” didn't finish uploading. Please attach it again.`);
    total += meta.size;
    if (total > MAX_TOTAL_BYTES) throw new HttpError(413, `Files can add up to ${MAX_TOTAL_BYTES / 1024 / 1024} MB per request.`);
    files.push({ id, meta });
  }
  for (const { id, meta } of files) await store().setJSON(`meta/${id}`, { ...meta, requestId });
  return files.map(({ id, meta }) => ({ upload: id, name: meta.name, type: meta.type, size: meta.size, chunks: meta.chunks }));
}

export async function getChunk(uploadId, index) {
  return store().get(`chunk/${uploadId}/${Number(index)}`, { type: "arrayBuffer" });
}

export async function deleteUpload(id) {
  const { blobs } = await store().list({ prefix: `chunk/${id}/` });
  await Promise.all(blobs.map((b) => store().delete(b.key)));
  await store().delete(`meta/${id}`);
}

// Remove uploads that were never attached to a request (form abandoned).
export async function cleanupPending(now = Date.now()) {
  const { blobs } = await store().list({ prefix: "meta/" });
  let removed = 0;
  for (const b of blobs) {
    const meta = await store().get(b.key, { type: "json" });
    if (meta && !meta.requestId && now - meta.created > PENDING_TTL_MS) {
      await deleteUpload(b.key.slice(5));
      removed++;
    }
  }
  return removed;
}

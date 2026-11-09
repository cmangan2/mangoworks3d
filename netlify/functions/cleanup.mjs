// Daily: delete file uploads from quote forms that were never submitted.
import { cleanupPending } from "../lib/uploads.mjs";

export const config = { schedule: "@daily" };

export default async function handler() {
  const removed = await cleanupPending();
  console.log(`cleanup: removed ${removed} abandoned upload(s)`);
  return new Response(`removed ${removed}`);
}

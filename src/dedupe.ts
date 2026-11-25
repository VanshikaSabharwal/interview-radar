/**
 * Make sure each student sees each job at most once.
 *
 *  1. Every job gets a stable ID: a hash of title + company + location.
 *     The same listing found by two different searches gets the same ID.
 *  2. Within a run, duplicates are dropped (`dedupeWithinRun`).
 *  3. Across runs, the IDs of jobs a student has already seen are stored in
 *     Upstash Redis with a 30-day expiry, and skipped next time (`filterUnseen`).
 */
import { createHash } from "node:crypto";
import { redis } from "./redis.js";
import type { Job } from "./types.js";

/** Lowercase and collapse whitespace so "Acme  Inc" and "acme inc" match. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** A short, stable ID for a job. Same inputs always produce the same ID. */
export function jobId(title: string, company: string, location: string): string {
  const key = [title, company, location].map(normalize).join("|");
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** Keep the first occurrence of each job ID and drop the rest. */
export function dedupeWithinRun<T extends Job>(jobs: T[]): T[] {
  const seen = new Set<string>();
  return jobs.filter((job) => {
    if (seen.has(job.id)) return false;
    seen.add(job.id);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Redis: which jobs has each student already seen?
// ---------------------------------------------------------------------------

/** Redis key, e.g. "seen:123456789:3f2a9c...". Separate per student. */
const seenKey = (userId: number, id: string) => `seen:${userId}:${id}`;

/** Return only the jobs this student has NOT seen before. */
export async function filterUnseen<T extends Job>(userId: number, jobs: T[]): Promise<T[]> {
  if (jobs.length === 0) return [];
  // One MGET round trip for all jobs: each value is "1" if seen, null if not.
  const values = await redis().mget<(string | null)[]>(...jobs.map((j) => seenKey(userId, j.id)));
  return jobs.filter((_, i) => values[i] === null);
}

/** Remember these jobs as seen by this student. Each key deletes itself after `ttlDays`. */
export async function markSeen(userId: number, jobs: Job[], ttlDays: number): Promise<void> {
  if (jobs.length === 0) return;
  const pipeline = redis().pipeline();
  for (const job of jobs) {
    pipeline.set(seenKey(userId, job.id), "1", { ex: ttlDays * 24 * 60 * 60 });
  }
  await pipeline.exec();
}

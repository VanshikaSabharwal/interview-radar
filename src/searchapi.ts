/**
 * Step 2: fetch internship listings from SearchApi's Google Jobs engine.
 * Docs: https://www.searchapi.io/docs/google-jobs
 */
import type { Search } from "../radar.config.js";
import { jobId } from "./dedupe.js";
import { requireEnv } from "./env.js";
import type { Job } from "./types.js";

const SEARCHAPI_URL = "https://www.searchapi.io/api/v1/search";

/** The parts of SearchApi's job object that we use (it has many more). */
interface RawJob {
  title?: string;
  company_name?: string;
  location?: string;
  via?: string;
  description?: string;
  detected_extensions?: { posted_at?: string };
  apply_link?: string;
  apply_links?: { link: string; source?: string }[];
  sharing_link?: string;
}

/**
 * Build the request URL for one search.
 * Google Jobs has no "remote" location, so for remote searches we put the word
 * "remote" in the query text and leave the location out.
 */
export function buildSearchUrl(search: Search, apiKey: string): string {
  const isRemote = search.location.trim().toLowerCase() === "remote";
  const params = new URLSearchParams({
    engine: "google_jobs",
    q: isRemote ? `${search.query} remote` : search.query,
    api_key: apiKey,
  });
  if (!isRemote) params.set("location", search.location);
  if (search.country) params.set("gl", search.country);
  return `${SEARCHAPI_URL}?${params}`;
}

/** Descriptions often contain HTML (<p>, <ul>, &amp;). Strip it and collapse whitespace. */
export function cleanText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Turn SearchApi's raw response into our small `Job` shape. */
export function parseJobs(body: { jobs?: RawJob[] }): Job[] {
  const jobs: Job[] = [];
  for (const raw of body.jobs ?? []) {
    const title = raw.title?.trim();
    const company = raw.company_name?.trim();
    // Prefer the direct apply link, then the first listed one, then Google's page.
    const applyLink = raw.apply_link ?? raw.apply_links?.[0]?.link ?? raw.sharing_link;

    // A listing without these isn't useful to a student, so skip it.
    if (!title || !company || !applyLink) continue;

    // Keep every place the job can be applied to (Phase 3 looks for the company's own site).
    const applyLinks = raw.apply_links?.length
      ? raw.apply_links
      : [{ link: applyLink, source: raw.via?.replace(/^via\s+/i, "") }];

    const location = raw.location?.trim() || "Location not listed";
    jobs.push({
      id: jobId(title, company, location),
      title,
      company,
      location,
      postedAt: raw.detected_extensions?.posted_at,
      applyLink,
      applyLinks,
      // A short piece of the description is enough for matching, and keeps Redis and AI prompts small.
      summary: raw.description ? cleanText(raw.description).slice(0, 300) : undefined,
    });
  }
  return jobs;
}

/**
 * Run `fn`; if it throws, wait a moment and try again (up to `retries` times).
 * Keeping this generic makes it easy to test without hitting the network.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  { retries = 1, delayMs = 2000, label = "request" } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= retries) throw error;
      console.warn(`[retry] ${label} failed (${errorMessage(error)}), retrying in ${delayMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** Fetch and parse the jobs for one search. Retries once on failure. */
export async function fetchJobs(search: Search): Promise<Job[]> {
  const url = buildSearchUrl(search, requireEnv("SEARCHAPI_API_KEY"));
  const label = `"${search.query}" in ${search.location}`;

  return withRetry(
    async () => {
      // Abort if SearchApi takes longer than 30s so one slow query can't hang the run.
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.error) {
        throw new Error(`SearchApi HTTP ${res.status}: ${body.error ?? res.statusText}`);
      }
      return parseJobs(body);
    },
    { label },
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

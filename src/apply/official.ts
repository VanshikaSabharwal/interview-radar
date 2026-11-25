/**
 * Phase 3 safety rule: apply ONLY on the company's own careers website.
 *
 *  1. Find the company's official domain (Google via SearchApi: knowledge panel, then top results).
 *  2. The domain must look like the company's name, and must not be a job board or hiring platform.
 *  3. Use an apply link only if it is on that domain (or a subdomain like careers.acme.com).
 *
 * When unsure, we say no: the student gets the link and applies themselves.
 */
import { getDomain } from "tldts";
import { redis } from "../redis.js";
import { requireEnv } from "../env.js";
import { withRetry } from "../searchapi.js";
import type { Job } from "../types.js";

/** Never treated as a company's own site: job boards, hiring platforms, social networks, directories. */
const NOT_COMPANY_SITES = new Set([
  // job boards and aggregators
  "linkedin.com", "indeed.com", "naukri.com", "glassdoor.com", "glassdoor.co.in", "internshala.com", "wellfound.com",
  "angel.co", "foundit.in", "monster.com", "shine.com", "instahyre.com", "cutshort.io", "hirist.tech", "iimjobs.com",
  "timesjobs.com", "apna.co", "workindia.in", "unstop.com", "simplyhired.com", "ziprecruiter.com", "jooble.org",
  "talent.com", "whatjobs.com", "jobrapido.com", "careerjet.co.in", "freshersworld.com", "letsintern.com",
  "ambitionbox.com", "himalayas.app", "remoteok.com", "weworkremotely.com", "builtin.com", "dice.com",
  // job sites that post other companies' jobs under their own name (add more as you spot them)
  "resumeforgeai.in",
  // hiring platforms (applicant tracking systems)
  "lever.co", "greenhouse.io", "myworkdayjobs.com", "workday.com", "ashbyhq.com", "smartrecruiters.com", "bamboohr.com",
  "zohorecruit.com", "zohorecruit.in", "freshteam.com", "keka.com", "darwinbox.in", "breezy.hr", "recruitee.com",
  "jobvite.com", "icims.com", "taleo.net", "successfactors.com", "teamtailor.com", "workable.com", "personio.de",
  "rippling.com", "jazzhr.com", "applytojob.com", "recruiterbox.com", "superset.com", "skillate.com", "hirequotient.com",
  // general sites
  "google.com", "facebook.com", "instagram.com", "x.com", "twitter.com", "youtube.com", "wikipedia.org",
  "crunchbase.com", "tracxn.com", "zaubacorp.com", "tofler.in", "justdial.com", "medium.com", "github.com",
]);

/** Words that don't identify a company: "Acme Technologies Pvt Ltd" → "acme". */
const GENERIC_WORDS = new Set([
  "pvt", "private", "ltd", "limited", "inc", "llc", "llp", "corp", "corporation", "co", "company", "the", "and",
  "technologies", "technology", "tech", "solutions", "software", "services", "systems", "labs", "lab", "india",
  "global", "group", "international", "ventures", "digital", "consulting", "careers", "jobs", "hq", "ai",
]);

/** Registrable domain of a URL: "https://careers.acme.co.in/x" → "acme.co.in". */
export function domainOf(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    return getDomain(host) ?? host;
  } catch {
    return null;
  }
}

/** Is `url` on `domain` itself or one of its subdomains? */
export function isOnDomain(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

/** Does this domain plausibly belong to this company? ("Jupiter Money" ↔ jupiter.money: yes) */
export function domainMatchesCompany(domain: string, company: string): boolean {
  const label = domain.split(".")[0].replace(/-/g, ""); // "jupiter" from "jupiter.money"
  const words = company.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && !GENERIC_WORDS.has(w));
  if (words.length === 0) return false;
  const compact = words.join(""); // "jupitermoney"
  if (label.length >= 3 && (compact === label || compact.startsWith(label) || label.startsWith(compact))) return true;
  return words.some((w) => w.length >= 4 && label.includes(w));
}

export function isCompanySiteCandidate(domain: string | null, company: string): domain is string {
  return !!domain && !NOT_COMPANY_SITES.has(domain) && domainMatchesCompany(domain, company);
}

/**
 * Find the company's official domain, e.g. "Jupiter Money" → "jupiter.money".
 * Returns null when we can't be sure. Cached for 30 days (1 SearchApi credit per new company).
 */
export async function findOfficialDomain(company: string): Promise<string | null> {
  const cacheKey = `company-domain:${company.toLowerCase().replace(/\s+/g, " ").trim()}`;
  const cached = await redis().get<string>(cacheKey);
  if (cached !== null) return cached || null; // "" means "looked it up, found nothing"

  const params = new URLSearchParams({ engine: "google", q: `${company} official website`, api_key: requireEnv("SEARCHAPI_API_KEY") });
  const body = await withRetry(
    async () => {
      const res = await fetch(`https://www.searchapi.io/api/v1/search?${params}`, { signal: AbortSignal.timeout(30_000) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error) throw new Error(`SearchApi HTTP ${res.status}: ${json.error ?? res.statusText}`);
      return json as { knowledge_graph?: { website?: string }; organic_results?: { link?: string }[] };
    },
    { label: `official site of ${company}` },
  );

  const candidates = [body.knowledge_graph?.website, ...(body.organic_results ?? []).slice(0, 5).map((r) => r.link)];
  let found: string | null = null;
  for (const url of candidates) {
    const domain = url ? domainOf(url) : null;
    if (isCompanySiteCandidate(domain, company)) {
      found = domain;
      break;
    }
  }
  await redis().set(cacheKey, found ?? "", { ex: 30 * 24 * 60 * 60 });
  console.log(`[official] ${company} → ${found ?? "not found"}`);
  return found;
}

/**
 * Quick check, with no API calls: does this job have an apply link on what looks like the
 * company's own website? Used to show students only jobs the bot can actually apply to.
 * (The Apply step later confirms the official domain with a search.)
 */
export function companySiteLink(job: Job): string | null {
  const links = [...job.applyLinks.map((l) => l.link), job.applyLink];
  return links.find((link) => isCompanySiteCandidate(domainOf(link), job.company)) ?? null;
}

/** The first apply link for this job that's on the official domain, if any. */
export function pickOfficialLink(job: Job, domain: string): string | null {
  const links = [...job.applyLinks.map((l) => l.link), job.applyLink];
  return links.find((link) => isOnDomain(link, domain)) ?? null;
}

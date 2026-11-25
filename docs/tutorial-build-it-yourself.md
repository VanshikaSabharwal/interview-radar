## 6. Build it yourself

Here's the core of Internship Radar, built step by step: a small Node.js + TypeScript project that fetches internships from Google Jobs every morning, removes the ones you've already seen, and sends the new ones to Telegram.

```
SearchApi (Google Jobs) → remove duplicates (Redis) → Telegram → every day at 9 AM (Vercel)
```

### Prerequisites

| You need | What it's for | Get it |
| --- | --- | --- |
| **SearchApi key** | Google Jobs results as JSON | [SearchApi](YOUR_TRACKED_LINK) → sign up → copy the API key |
| **Telegram bot** | Delivers the digest | Message **@BotFather** in Telegram → `/newbot` → copy the token |
| **Upstash Redis** | Remembers jobs already sent | [console.upstash.com](https://console.upstash.com) → create a database → copy the REST URL and token |
| **Vercel account** | Runs it every day for free | [vercel.com](https://vercel.com) |

Plus **Node.js 22+**. Set up the project:

```bash
mkdir internship-radar && cd internship-radar
npm init -y && npm pkg set type=module
npm install @upstash/redis
npm install -D typescript tsx @types/node
```

Put your keys in a `.env` file, and add `.env` to `.gitignore`:

```bash
SEARCHAPI_API_KEY=your_searchapi_key
UPSTASH_REDIS_REST_URL=https://your-db.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_upstash_token
TELEGRAM_BOT_TOKEN=123456789:AA...
TELEGRAM_CHAT_ID=          # filled in at step 3
CRON_SECRET=               # any long random string: openssl rand -hex 32
```

---

### Step 1: Fetch jobs from SearchApi

**What it does**

For each search (e.g. "frontend intern" in Bengaluru, and "frontend intern" remote), we call SearchApi's `google_jobs` engine and keep five fields: title, company, location, posted date, and apply link. A failed call is retried once. Google Jobs has no "remote" location, so for remote searches we add "remote" to the query instead.

**What the response looks like** (trimmed)

```json
{
  "jobs": [
    {
      "title": "Frontend Developer Intern",
      "company_name": "Acme",
      "location": "Bengaluru, Karnataka",
      "via": "via Acme Careers",
      "detected_extensions": { "posted_at": "2 days ago" },
      "apply_link": "https://careers.acme.com/jobs/123",
      "apply_links": [{ "link": "https://careers.acme.com/jobs/123", "source": "Acme Careers" }]
    }
  ]
}
```

**The code**: `src/searchapi.ts`

```ts
export interface Search {
  query: string;
  location: string; // a real place, or "remote"
}

export interface Job {
  title: string;
  company: string;
  location: string;
  postedAt?: string;
  applyLink: string;
}

// Edit this list to change what you're looking for.
export const SEARCHES: Search[] = [
  { query: "frontend intern", location: "Bengaluru, Karnataka, India" },
  { query: "frontend intern", location: "remote" },
];

export async function fetchJobs(search: Search): Promise<Job[]> {
  const isRemote = search.location.toLowerCase() === "remote";
  const params = new URLSearchParams({
    engine: "google_jobs",
    q: isRemote ? `${search.query} remote` : search.query,
    api_key: process.env.SEARCHAPI_API_KEY!,
  });
  if (isRemote) params.set("gl", "in"); // remote jobs open to India (Google defaults to the US)
  else params.set("location", search.location);

  // Try, and if it fails, wait 2 seconds and try once more.
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`https://www.searchapi.io/api/v1/search?${params}`);
      const body = await res.json();
      if (!res.ok || body.error) throw new Error(`HTTP ${res.status}: ${body.error ?? res.statusText}`);

      return (body.jobs ?? [])
        .map((j: any) => ({
          title: j.title,
          company: j.company_name,
          location: j.location ?? "Location not listed",
          postedAt: j.detected_extensions?.posted_at,
          applyLink: j.apply_link ?? j.apply_links?.[0]?.link,
        }))
        .filter((j: Job) => j.title && j.company && j.applyLink);
    } catch (error) {
      if (attempt === 2) throw error;
      console.warn(`Retrying "${search.query}":`, error);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
```

**How to test it**

Create `test-step1.ts`:

```ts
import { fetchJobs, SEARCHES } from "./src/searchapi.js";
console.table(await fetchJobs(SEARCHES[0]));
```

```bash
npx tsx --env-file=.env test-step1.ts
```

✅ You should see a table of about 10 real listings. If you get `HTTP 401`, check your API key.

---

### Step 2: Remove duplicates with Redis

**What it does**

The same job often appears in two searches, and you don't want yesterday's jobs again tomorrow. So each job gets a **stable ID**, a hash of its title + company + location. A `Set` removes repeats within one run. Redis remembers which IDs were already sent, and each one expires after **30 days**, so Redis cleans up after itself.

**The code**: `src/dedupe.ts`

```ts
import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import type { Job } from "./searchapi.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});
const THIRTY_DAYS = 30 * 24 * 60 * 60; // seconds

// Same title + company + location → same ID, every time.
export function jobId(job: Job): string {
  const key = [job.title, job.company, job.location]
    .map((s) => s.toLowerCase().replace(/\s+/g, " ").trim())
    .join("|");
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

// Remove repeats inside this run.
export function dedupeWithinRun(jobs: Job[]): Job[] {
  const seen = new Set<string>();
  return jobs.filter((job) => {
    const id = jobId(job);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// Keep only jobs not sent before (one Redis call for all of them).
export async function filterUnsent(jobs: Job[]): Promise<Job[]> {
  if (jobs.length === 0) return [];
  const values = await redis.mget<(string | null)[]>(...jobs.map((j) => `sent:${jobId(j)}`));
  return jobs.filter((_, i) => values[i] === null);
}

// Remember jobs as sent; each key deletes itself after 30 days.
export async function markSent(jobs: Job[]): Promise<void> {
  if (jobs.length === 0) return;
  const pipeline = redis.pipeline();
  for (const job of jobs) pipeline.set(`sent:${jobId(job)}`, "1", { ex: THIRTY_DAYS });
  await pipeline.exec();
}
```

**How to test it**

Create `test-step2.ts`:

```ts
import { dedupeWithinRun, filterUnsent, markSent } from "./src/dedupe.js";
import { fetchJobs, SEARCHES } from "./src/searchapi.js";

const all = (await Promise.all(SEARCHES.map(fetchJobs))).flat();
const unique = dedupeWithinRun(all);
const fresh = await filterUnsent(unique);
console.log(`${all.length} fetched → ${unique.length} unique → ${fresh.length} new`);
await markSent(fresh); // pretend we sent them
```

Run it twice:

```bash
npx tsx --env-file=.env test-step2.ts   # e.g. "20 fetched → 20 unique → 20 new"
npx tsx --env-file=.env test-step2.ts   # e.g. "20 fetched → 20 unique → 4 new"
```

✅ The second run finds far fewer new jobs, because Redis remembered the first batch. It may not be exactly 0, because Google often returns a slightly different set each time. You'll see the `sent:…` keys, each with a 30-day TTL, in Upstash's **Data Browser**. Delete them before step 3, so you have jobs to send.

---

### Step 3: Send to Telegram

**What it does**

Turns the new jobs into a digest: a header with the date and count, then `Title — Company (Location, posted X ago)` with an apply link. Telegram allows at most 4,096 characters per message, so long digests are split, and a job is never cut in half. Jobs are marked as sent **only after** Telegram accepts the message, so a failed send is retried tomorrow instead of lost. If there's nothing new, nothing is sent.

```
🎯 Internship Radar · 25 Nov 2026
3 new internships

1. Frontend Intern — Acme (Bengaluru, posted 2 days ago)
Apply →
```

First, **get your chat ID**: open your bot in Telegram and press **Start**. Then visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` and copy the number in `"chat":{"id":…`. Put it in `.env` as `TELEGRAM_CHAT_ID`.

**The code**: `src/telegram.ts`

```ts
import type { Job } from "./searchapi.js";

const LIMIT = 4000; // Telegram allows 4096; leave some room

// We send HTML, so characters like < & > in titles must be escaped.
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function formatJob(job: Job, n: number): string {
  const where = job.postedAt ? `${job.location}, posted ${job.postedAt}` : job.location;
  return `${n}. <b>${escape(job.title)}</b> — ${escape(job.company)} (${escape(where)})\n<a href="${escape(job.applyLink)}">Apply →</a>`;
}

// Build the digest, split into messages under Telegram's limit.
export function buildMessages(jobs: Job[]): { text: string; jobs: Job[] }[] {
  const date = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
  let current = { text: `🎯 <b>Internship Radar</b> · ${date}\n${jobs.length} new internships`, jobs: [] as Job[] };
  const messages = [current];

  jobs.forEach((job, i) => {
    const block = formatJob(job, i + 1);
    if (current.text.length + block.length + 2 > LIMIT) {
      current = { text: "🎯 <b>Internship Radar</b> (continued)", jobs: [] };
      messages.push(current);
    }
    current.text += `\n\n${block}`;
    current.jobs.push(job);
  });
  return messages;
}

export async function sendMessage(text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`Telegram: ${body.description}`);
}
```

Then connect all three steps in `src/radar.ts`:

```ts
import { dedupeWithinRun, filterUnsent, markSent } from "./dedupe.js";
import { fetchJobs, SEARCHES, type Job } from "./searchapi.js";
import { buildMessages, sendMessage } from "./telegram.js";

export async function runRadar() {
  // 1. Fetch. One failing search is logged and skipped, never fatal.
  const all: Job[] = [];
  for (const search of SEARCHES) {
    try {
      all.push(...(await fetchJobs(search)));
    } catch (error) {
      console.error(`"${search.query}" in ${search.location} failed:`, error);
    }
  }

  // 2. Remove duplicates and jobs already sent.
  const fresh = await filterUnsent(dedupeWithinRun(all));
  console.log(`${all.length} fetched → ${fresh.length} new`);
  if (fresh.length === 0) return { sent: 0 }; // nothing new → no message

  // 3. Send, and mark each message's jobs right after it goes through.
  for (const message of buildMessages(fresh)) {
    await sendMessage(message.text);
    await markSent(message.jobs);
  }
  return { sent: fresh.length };
}
```

**How to test it**

Create `test-step3.ts`:

```ts
import { runRadar } from "./src/radar.js";
console.log(await runRadar());
```

```bash
npx tsx --env-file=.env test-step3.ts
```

✅ Your phone buzzes with the digest. Run it again right away: nothing is sent, or only the few jobs Google didn't return the first time.

---

### Step 4: Schedule with Vercel Cron

**What it does**

Puts the radar behind a URL, `/api/run`, and has Vercel call it every morning. Anyone could find that URL, so it checks a secret: Vercel sends `Authorization: Bearer <CRON_SECRET>` with each scheduled call, and every other request gets a 401.

> Vercel now calls this feature **Schedules**. It replaced Cron Jobs and works the same way here. If your account still uses Cron Jobs, there's a one-line alternative below.

**The code**: `api/run.ts` (every file in `api/` becomes a serverless function)

```ts
import { runRadar } from "../src/radar.js";

export async function GET(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return Response.json(await runRadar());
}
```

`vercel.json`: `30 3 * * *` is 03:30 UTC, which is **9:00 AM in India**:

```json
{
  "schedules": {
    "daily-radar": { "schedule": "30 3 * * *", "path": "/api/run", "requestMethod": "GET" }
  }
}
```

Using the older Cron Jobs? Use `"crons": [{ "path": "/api/run", "schedule": "30 3 * * *" }]` instead of the `schedules` block.

Deploy: push to GitHub, import the repo at [vercel.com/new](https://vercel.com/new) (Framework Preset: **Other**), add everything from `.env` under **Settings → Environment Variables**, then deploy.

**How to test it**

```bash
# Without the secret → 401
curl -i https://YOUR-APP.vercel.app/api/run

# With the secret → runs the radar, returns {"sent": …}
curl -H "Authorization: Bearer YOUR_CRON_SECRET" https://YOUR-APP.vercel.app/api/run
```

✅ In the Vercel dashboard, **Project → Schedules** shows the next run time and past runs. Click **Run** to trigger it now. On the free Hobby plan, runs can start up to 15 minutes late, so expect the digest between 9:00 and about 9:15 AM.

That's it. Every morning, fresh internships land on your phone, and you never see the same one twice. 🎯

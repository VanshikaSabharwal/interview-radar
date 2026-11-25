/**
 * Phase 2 pipeline: find and send new job matches to each student.
 *
 *   for each active student:
 *     searches from profile → fetch (shared cache) → dedupe → drop already-seen →
 *     AI scores → keep the best → send one message per job with [Apply] [Skip]
 *
 * Used by the daily schedule (api/run.ts), the /jobs command (bot.ts), and `npm run once`.
 */
import { config, type Search } from "../radar.config.js";
import { companySiteLink } from "./apply/official.js";
import { dedupeWithinRun, filterUnseen, markSeen } from "./dedupe.js";
import { saveJobs } from "./jobs.js";
import { formatMatch, pickMatches, scoreJobs, searchesFor } from "./matching.js";
import { errorMessage, fetchJobs } from "./searchapi.js";
import { listActiveStudents, type Student } from "./students.js";
import { sendMessage } from "./telegram.js";
import type { Job } from "./types.js";

/**
 * Search results shared by everyone in one run: if two students both want
 * "frontend intern" in Bengaluru, SearchApi is only called once.
 */
export type SearchCache = Map<string, Promise<Job[]>>;

function cachedFetch(search: Search, cache: SearchCache): Promise<Job[]> {
  const key = `${search.query.toLowerCase()}|${search.location.toLowerCase()}`;
  let result = cache.get(key);
  if (!result) {
    result = fetchJobs(search);
    cache.set(key, result);
  }
  return result;
}

export interface StudentRunOptions {
  /** Print matches instead of sending them, and don't mark anything as seen. */
  dryRun?: boolean;
  /** Tell the student when nothing new was found (for /jobs; the daily run stays quiet). */
  notifyIfNone?: boolean;
  cache?: SearchCache;
}

export interface StudentRunResult {
  userId: number;
  searched: number;
  failedSearches: number;
  fetched: number;
  unseen: number;
  sent: number;
}

/** Find and send new matches for one student. */
export async function findMatchesForStudent(student: Student, options: StudentRunOptions = {}): Promise<StudentRunResult> {
  const { dryRun = false, notifyIfNone = false, cache = new Map() } = options;
  const result: StudentRunResult = { userId: student.userId, searched: 0, failedSearches: 0, fetched: 0, unseen: 0, sent: 0 };
  if (!student.profile) return result;

  // 1. Fetch every search. One failing search is logged and skipped.
  const searches = searchesFor(student.profile);
  const all: Job[] = [];
  for (const search of searches) {
    result.searched++;
    try {
      all.push(...(await cachedFetch(search, cache)));
    } catch (error) {
      result.failedSearches++;
      console.error(`[match] user ${student.userId}: "${search.query}" in ${search.location} failed: ${errorMessage(error)}`);
    }
  }
  result.fetched = all.length;

  // 2. Dedupe, then drop jobs this student has already seen.
  const unique = dedupeWithinRun(all);
  const fresh = dryRun ? unique : await filterUnseen(student.userId, unique);
  result.unseen = fresh.length;

  // 3. Keep only jobs with an apply link on the company's own website: the only ones the bot applies to.
  const onCompanySite = fresh.flatMap((job) => {
    const link = companySiteLink(job);
    return link ? [{ ...job, officialLink: link }] : [];
  });

  // 4. AI scores, then keep the best few.
  const scored = await scoreJobs(student.profile, onCompanySite);
  const matches = pickMatches(scored, config.minMatchScore, config.maxMatchesPerRun);
  console.log(
    `[match] user ${student.userId}: ${all.length} fetched → ${fresh.length} new → ${onCompanySite.length} on company sites → ${matches.length} good matches`,
  );

  if (dryRun) {
    for (const m of matches) console.log(`\n${formatMatch(m)}`);
    result.sent = matches.length;
    return result;
  }

  // Jobs that scored too low are marked seen too, so we don't pay to score them again tomorrow.
  const matchIds = new Set(matches.map((m) => m.id));
  await markSeen(student.userId, fresh.filter((j) => !matchIds.has(j.id)), config.seenJobTtlDays);

  if (matches.length === 0) {
    if (notifyIfNone) await sendMessage(student.chatId, "No new matches right now. I'll check again tomorrow morning. 🌅");
    return result;
  }

  // 5. Send: a short header, then one message per job with its own buttons.
  await saveJobs(matches); // so the Apply button can find the job later
  const day = new Intl.DateTimeFormat("en-IN", { timeZone: config.timezone, day: "numeric", month: "short" }).format(new Date());
  await sendMessage(
    student.chatId,
    `🎯 <b>${matches.length} new ${matches.length === 1 ? "match" : "matches"} for you</b> · ${day}\nTap ✅ Apply on the ones you like.`,
  );
  for (const m of matches) {
    await sendMessage(student.chatId, formatMatch(m), [
      [
        { text: "✅ Apply", data: `apply:${m.id}` },
        { text: "⏭ Skip", data: `skip:${m.id}` },
      ],
    ]);
    // Mark each job seen right after it's sent, so a failure halfway never repeats or loses jobs.
    await markSeen(student.userId, [m], config.seenJobTtlDays);
    result.sent++;
  }
  return result;
}

export interface DailySummary {
  students: number;
  succeeded: number;
  failed: number;
  matchesSent: number;
  searchApiCalls: number;
}

/** The daily run: every active student, a few at a time. One student's failure never stops the others. */
export async function runDaily(options: { dryRun?: boolean } = {}): Promise<DailySummary> {
  const students = await listActiveStudents();
  const cache: SearchCache = new Map();
  const summary: DailySummary = { students: students.length, succeeded: 0, failed: 0, matchesSent: 0, searchApiCalls: 0 };
  console.log(`[daily] ${students.length} active students`);

  // Simple worker pool: `concurrency` workers each take the next student from the queue.
  const queue = [...students];
  const worker = async () => {
    for (let student = queue.shift(); student; student = queue.shift()) {
      try {
        const r = await findMatchesForStudent(student, { dryRun: options.dryRun, cache });
        summary.succeeded++;
        summary.matchesSent += r.sent;
      } catch (error) {
        summary.failed++;
        console.error(`[daily] user ${student.userId} failed:`, error);
      }
    }
  };
  await Promise.all(Array.from({ length: config.concurrency }, worker));

  summary.searchApiCalls = cache.size;
  console.log("[daily] done:", summary);
  return summary;
}

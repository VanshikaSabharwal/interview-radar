/**
 * Phase 2: find jobs that fit a student.
 *
 *   profile ──searchesFor──▶ searches ──SearchApi──▶ jobs ──AI scores──▶ pickMatches ──▶ top matches
 */
import { generateText, type LanguageModel, Output } from "ai";
import { z } from "zod";
import { config, type Search } from "../radar.config.js";
import { model } from "./ai.js";
import type { Profile } from "./profile.js";
import { escapeHtml } from "./telegram.js";
import type { Job, Match } from "./types.js";

/** Every role × every location, capped so one student can't use too many search credits. */
export function searchesFor(profile: Profile): Search[] {
  const locations = profile.preferredLocations.length ? profile.preferredLocations : ["remote"];
  const searches: Search[] = [];
  for (const query of profile.targetRoles) {
    for (const location of locations) {
      searches.push({ query, location, country: config.defaultCountry });
    }
  }
  return searches.slice(0, config.maxSearchesPerStudent);
}

const ScoresSchema = z.object({
  scores: z.array(
    z.object({
      index: z.number().describe("The job's index from the list"),
      score: z.number().describe("0-100: how well this job fits the student"),
      reason: z.string().describe("Max 15 words, addressed to the student, e.g. 'Your React + TypeScript projects fit; Bengaluru-based.'"),
    }),
  ),
});

/**
 * Ask the AI to score every job against the profile. Returns jobs with score + reason.
 * `llm` defaults to the app's model; tests pass a mock instead.
 */
export async function scoreJobs(profile: Profile, jobs: Job[], llm: LanguageModel = model): Promise<Match[]> {
  if (jobs.length === 0) return [];
  // Keep the prompt small: Groq's free tier allows ~8,000 tokens per minute.
  jobs = jobs.slice(0, config.maxJobsToScore);

  // Send only what matters for matching. Contact details never leave our side here.
  const student = {
    headline: profile.headline,
    skills: profile.skills,
    education: profile.education.map((e) => ({ degree: e.degree, field: e.field, graduationYear: e.graduationYear })),
    experience: profile.experience.map((e) => `${e.title} at ${e.company}`),
    projects: profile.projects.map((p) => p.name),
    wants: profile.targetRoles,
    locations: profile.preferredLocations,
  };
  const list = jobs.map((j, index) => ({ index, title: j.title, company: j.company, location: j.location, summary: j.summary?.slice(0, 200) }));

  const { output } = await generateText({
    model: llm,
    output: Output.object({ schema: ScoresSchema }),
    // Scoring is simple, so less "thinking" is fine, and it saves tokens. (Ignored by non-Groq models.)
    providerOptions: { groq: { reasoningEffort: "low" } },
    // On a rate limit (HTTP 429) the SDK waits and retries. A few extra tries ride out the per-minute limit.
    maxRetries: 4,
    system:
      "You match students to job listings. Score every job from 0 to 100 for this student.\n" +
      "- High: the role is what they want, at their level (internship / entry level), in a location they accept, and their skills fit.\n" +
      "- Low: senior roles, unrelated fields, required experience they clearly don't have, or locations they didn't ask for.\n" +
      "- Judge only from the information given. Return one score per job index.",
    prompt: `Student:\n${JSON.stringify(student)}\n\nJobs:\n${JSON.stringify(list)}`,
  });

  const matches: Match[] = [];
  for (const s of output.scores) {
    const job = jobs[s.index];
    if (job) matches.push({ ...job, score: Math.round(Math.max(0, Math.min(100, s.score))), reason: s.reason });
  }
  return matches;
}

/** Keep good matches only, best first, at most `max`. */
export function pickMatches(scored: Match[], minScore: number, max: number): Match[] {
  return scored
    .filter((m) => m.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}

/** One match as a Telegram message (HTML). */
export function formatMatch(m: Match): string {
  const when = m.postedAt ? ` · 🕒 ${escapeHtml(m.postedAt)}` : "";
  const link = m.officialLink ?? m.applyLink;
  const host = new URL(link).hostname.replace(/^www\./, "");
  return (
    `<b>${escapeHtml(m.title)}</b> — ${escapeHtml(m.company)}\n` +
    `📍 ${escapeHtml(m.location)}${when}\n` +
    `⭐ <b>${m.score}% match</b>: ${escapeHtml(m.reason)}\n` +
    `🏢 <a href="${escapeHtml(link)}">Listing on ${escapeHtml(host)} →</a>`
  );
}

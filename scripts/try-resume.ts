/**
 * Run a resume through the whole matching flow without Telegram or Redis:
 *   PDF → text → AI profile → searches → SearchApi → AI scores → matches
 *
 *   npm run try-resume                       (uses samples/demo-resume.pdf)
 *   npm run try-resume -- path/to/resume.pdf
 *
 * Costs up to 4 SearchApi credits and a few AI calls. Nothing is sent or saved.
 */
import { readFileSync } from "node:fs";
import { config } from "../radar.config.js";
import { companySiteLink } from "../src/apply/official.js";
import { dedupeWithinRun } from "../src/dedupe.js";
import { pickMatches, scoreJobs, searchesFor } from "../src/matching.js";
import { parseResume, pdfToText } from "../src/resume.js";
import { errorMessage, fetchJobs } from "../src/searchapi.js";
import type { Job } from "../src/types.js";

const path = process.argv[2] ?? "samples/demo-resume.pdf";

const text = await pdfToText(new Uint8Array(readFileSync(path)));
console.log(`1) ${path}: ${text.length} characters of text`);

const profile = await parseResume(text);
console.log(`2) Profile: ${profile.name}, ${profile.headline}`);
console.log(`   email=${profile.email} phone=${profile.phone} city=${profile.city} linkedin=${profile.links.linkedin}`);
console.log(`   skills: ${profile.skills.join(", ")}`);
console.log(`   roles: ${profile.targetRoles.join(" | ")}`);
console.log(`   locations: ${profile.preferredLocations.join(" | ")}`);

const all: Job[] = [];
for (const search of searchesFor(profile)) {
  try {
    const jobs = await fetchJobs(search);
    console.log(`3) "${search.query}" in ${search.location}: ${jobs.length} jobs`);
    all.push(...jobs);
  } catch (error) {
    console.log(`3) "${search.query}" in ${search.location}: FAILED (${errorMessage(error)})`);
  }
}

const unique = dedupeWithinRun(all);
const onCompanySite = unique.flatMap((job) => {
  const link = companySiteLink(job);
  return link ? [{ ...job, officialLink: link }] : [];
});
console.log(`4) ${unique.length} unique jobs, ${onCompanySite.length} with an apply link on the company's own site:`);
for (const j of onCompanySite) console.log(`   • ${j.company}: ${j.officialLink}`);
const scored = await scoreJobs(profile, onCompanySite);
const matches = pickMatches(scored, config.minMatchScore, config.maxMatchesPerRun);
console.log(`5) ${scored.length} scored → ${matches.length} matches at ${config.minMatchScore}%+`);
console.log(`   all scores: ${scored.map((m) => m.score).sort((a, b) => b - a).join(", ")}`);
for (const m of matches) console.log(`   ${m.score}%  ${m.title} — ${m.company} (${m.location}): ${m.reason}`);

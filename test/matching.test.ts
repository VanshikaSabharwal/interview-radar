import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { config } from "../radar.config.js";
import { formatMatch, pickMatches, scoreJobs, searchesFor } from "../src/matching.js";
import type { Profile } from "../src/profile.js";
import type { Job, Match } from "../src/types.js";

const profile: Profile = {
  name: "Asha Verma",
  email: "asha@example.com",
  phone: null,
  city: "Bengaluru",
  headline: "Final-year CS student, React + TypeScript",
  education: [],
  skills: ["React", "TypeScript"],
  experience: [],
  projects: [],
  links: { linkedin: null, github: null, portfolio: null },
  targetRoles: ["frontend intern", "react developer intern", "ui engineer intern"],
  preferredLocations: ["Bengaluru, Karnataka, India", "remote"],
};

const job = (n: number): Job => ({
  id: `id${n}`,
  title: `Frontend Intern ${n}`,
  company: "Acme",
  location: "Bengaluru",
  postedAt: "2 days ago",
  applyLink: `https://acme.example/jobs/${n}?a=1&b=2`,
  applyLinks: [{ link: `https://acme.example/jobs/${n}` }],
});

/** A fake AI model that always answers with `json`. */
function mockModel(json: unknown) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(json) }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 20, text: 20, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

test("searchesFor: roles × locations, capped by config", () => {
  const searches = searchesFor(profile);
  assert.equal(searches.length, config.maxSearchesPerStudent);
  assert.deepEqual(searches[0], { query: "frontend intern", location: "Bengaluru, Karnataka, India", country: config.defaultCountry });
  assert.equal(searches[1].location, "remote");
});

test("searchesFor: falls back to remote when no locations are set", () => {
  const searches = searchesFor({ ...profile, targetRoles: ["frontend intern"], preferredLocations: [] });
  assert.deepEqual(searches.map((s) => s.location), ["remote"]);
});

test("scoreJobs: maps AI scores back to jobs, clamps scores, ignores unknown indexes", async () => {
  const llm = mockModel({
    scores: [
      { index: 0, score: 91.6, reason: "Strong React fit" },
      { index: 1, score: 140, reason: "Too high, gets clamped" },
      { index: 7, score: 80, reason: "No such job" },
    ],
  });
  const scored = await scoreJobs(profile, [job(1), job(2)], llm);
  assert.equal(scored.length, 2);
  assert.equal(scored[0].id, "id1");
  assert.equal(scored[0].score, 92);
  assert.equal(scored[1].score, 100);
});

test("scoreJobs: no jobs means no AI call", async () => {
  const llm = mockModel({ scores: [] });
  assert.deepEqual(await scoreJobs(profile, [], llm), []);
  assert.equal(llm.doGenerateCalls.length, 0);
});

test("pickMatches: keeps good scores, best first, at most max", () => {
  const scored: Match[] = [40, 95, 70, 60, 85].map((score, i) => ({ ...job(i), score, reason: "" }));
  const picked = pickMatches(scored, 60, 3);
  assert.deepEqual(picked.map((m) => m.score), [95, 85, 70]);
});

test("formatMatch: shows title, company, score, reason and the official link's site", () => {
  const text = formatMatch({ ...job(1), officialLink: "https://careers.acme.com/jobs/1?a=1&b=2", score: 88, reason: "React & TS fit" });
  assert.match(text, /<b>Frontend Intern 1<\/b> — Acme/);
  assert.match(text, /📍 Bengaluru · 🕒 2 days ago/);
  assert.match(text, /88% match<\/b>: React &amp; TS fit/);
  assert.match(text, /href="https:\/\/careers\.acme\.com\/jobs\/1\?a=1&amp;b=2">Listing on careers\.acme\.com/);
});

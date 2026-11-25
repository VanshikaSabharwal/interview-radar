import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSearchUrl, parseJobs, withRetry } from "../src/searchapi.js";

test("buildSearchUrl: normal location is passed as `location`", () => {
  const url = new URL(buildSearchUrl({ query: "frontend intern", location: "Bengaluru" }, "KEY"));
  assert.equal(url.searchParams.get("engine"), "google_jobs");
  assert.equal(url.searchParams.get("q"), "frontend intern");
  assert.equal(url.searchParams.get("location"), "Bengaluru");
});

test("buildSearchUrl: 'remote' goes into the query, not the location", () => {
  const url = new URL(buildSearchUrl({ query: "frontend intern", location: "Remote", country: "in" }, "KEY"));
  assert.equal(url.searchParams.get("q"), "frontend intern remote");
  assert.equal(url.searchParams.get("location"), null);
  assert.equal(url.searchParams.get("gl"), "in");
});

test("parseJobs: extracts fields and falls back between apply links", () => {
  const jobs = parseJobs({
    jobs: [
      {
        title: "Frontend Intern",
        company_name: "Acme",
        location: "Bengaluru, Karnataka",
        via: "via Acme Careers",
        description: "Build   React\n components.",
        detected_extensions: { posted_at: "2 days ago" },
        apply_link: "https://acme.example/apply",
      },
      {
        title: "UI Intern",
        company_name: "Beta",
        apply_links: [{ link: "https://beta.example/jobs/1", source: "Beta Careers" }],
      },
      { title: "No company, skipped", apply_link: "https://x.example" },
    ],
  });

  assert.equal(jobs.length, 2);
  assert.deepEqual(
    { ...jobs[0], id: undefined },
    {
      id: undefined,
      title: "Frontend Intern",
      company: "Acme",
      location: "Bengaluru, Karnataka",
      postedAt: "2 days ago",
      applyLink: "https://acme.example/apply",
      applyLinks: [{ link: "https://acme.example/apply", source: "Acme Careers" }],
      summary: "Build React components.",
    },
  );
  assert.equal(jobs[1].applyLink, "https://beta.example/jobs/1");
  assert.deepEqual(jobs[1].applyLinks, [{ link: "https://beta.example/jobs/1", source: "Beta Careers" }]);
  assert.equal(jobs[1].location, "Location not listed");
});

test("parseJobs: handles a response with no jobs", () => {
  assert.deepEqual(parseJobs({}), []);
});

test("withRetry: retries once, then succeeds", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return "ok";
    },
    { delayMs: 0 },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});

test("withRetry: gives up after the retry and throws", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new Error("always fails");
      },
      { delayMs: 0 },
    ),
    /always fails/,
  );
  assert.equal(calls, 2);
});

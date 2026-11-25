import assert from "node:assert/strict";
import { test } from "node:test";
import { dedupeWithinRun, jobId } from "../src/dedupe.js";
import type { Job } from "../src/types.js";

test("jobId is stable and ignores case/extra spaces", () => {
  const a = jobId("Frontend Intern", "Acme Inc", "Bengaluru");
  const b = jobId("  frontend   intern ", "ACME INC", "bengaluru");
  assert.equal(a, b);
  assert.equal(a.length, 16);
});

test("jobId differs when any field differs", () => {
  const base = jobId("Frontend Intern", "Acme", "Bengaluru");
  assert.notEqual(base, jobId("Backend Intern", "Acme", "Bengaluru"));
  assert.notEqual(base, jobId("Frontend Intern", "Beta", "Bengaluru"));
  assert.notEqual(base, jobId("Frontend Intern", "Acme", "Pune"));
});

test("dedupeWithinRun keeps the first copy of each job", () => {
  const make = (title: string, link: string): Job => ({
    id: jobId(title, "Acme", "Bengaluru"),
    title,
    company: "Acme",
    location: "Bengaluru",
    applyLink: link,
    applyLinks: [{ link }],
  });
  const jobs = [make("Frontend Intern", "first"), make("UI Intern", "x"), make("frontend intern", "second")];
  const unique = dedupeWithinRun(jobs);
  assert.equal(unique.length, 2);
  assert.equal(unique[0].applyLink, "first");
});

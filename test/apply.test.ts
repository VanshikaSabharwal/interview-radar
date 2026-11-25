import assert from "node:assert/strict";
import { test } from "node:test";
import { answerKey, buildPlan, planAnswers } from "../src/apply/answers.js";
import { companySiteLink, domainMatchesCompany, domainOf, isCompanySiteCandidate, isOnDomain, pickOfficialLink } from "../src/apply/official.js";
import type { FormField } from "../src/apply/runner.js";
import type { Profile } from "../src/profile.js";
import type { Job } from "../src/types.js";

// ---------------------------------------------------------------------------
// Official website rules
// ---------------------------------------------------------------------------

test("domainOf returns the registrable domain", () => {
  assert.equal(domainOf("https://careers.acme.co.in/jobs/1"), "acme.co.in");
  assert.equal(domainOf("https://jobs.lever.co/acme"), "lever.co");
  assert.equal(domainOf("not a url"), null);
});

test("isOnDomain accepts the domain and its subdomains only", () => {
  assert.ok(isOnDomain("https://acme.com/careers", "acme.com"));
  assert.ok(isOnDomain("https://careers.acme.com/x", "acme.com"));
  assert.ok(!isOnDomain("https://acme.com.evil.io/x", "acme.com"));
  assert.ok(!isOnDomain("https://notacme.com/x", "acme.com"));
  assert.ok(!isOnDomain("https://jobs.lever.co/acme", "acme.com"));
});

test("domainMatchesCompany: the domain must look like the company's name", () => {
  assert.ok(domainMatchesCompany("jupiter.money", "Jupiter Money"));
  assert.ok(domainMatchesCompany("infilect.com", "Infilect"));
  assert.ok(domainMatchesCompany("thundertribes.com", "thundertribes"));
  assert.ok(domainMatchesCompany("acme.co.in", "Acme Technologies Pvt Ltd"));
  assert.ok(!domainMatchesCompany("randomsite.com", "Acme Technologies"));
  assert.ok(!domainMatchesCompany("ai.com", "AI Labs")); // only generic words
});

test("job boards and hiring platforms are never the company's site", () => {
  assert.ok(!isCompanySiteCandidate("linkedin.com", "LinkedIn"));
  assert.ok(!isCompanySiteCandidate("lever.co", "Lever"));
  assert.ok(!isCompanySiteCandidate("naukri.com", "Naukri"));
  assert.ok(isCompanySiteCandidate("razorpay.com", "Razorpay"));
});

test("companySiteLink: only jobs with a link on the company's own site pass", () => {
  const base = { id: "1", title: "Intern", location: "Bengaluru", summary: "" };
  const zenoti: Job = {
    ...base,
    company: "Zenoti",
    applyLink: "https://www.linkedin.com/jobs/view/9",
    applyLinks: [
      { link: "https://www.linkedin.com/jobs/view/9", source: "LinkedIn" },
      { link: "https://jobs.lever.co/zenoti/123", source: "Lever" },
    ],
  };
  const acme: Job = {
    ...base,
    company: "Acme Technologies",
    applyLink: "https://www.naukri.com/job/1",
    applyLinks: [
      { link: "https://www.naukri.com/job/1", source: "Naukri" },
      { link: "https://careers.acme.in/openings/7", source: "Acme Careers" },
    ],
  };
  assert.equal(companySiteLink(zenoti), null); // LinkedIn + Lever only → not shown
  assert.equal(companySiteLink(acme), "https://careers.acme.in/openings/7");
});

test("pickOfficialLink picks only links on the official domain", () => {
  const job: Job = {
    id: "1",
    title: "Intern",
    company: "Acme",
    location: "Bengaluru",
    applyLink: "https://www.linkedin.com/jobs/view/1",
    applyLinks: [
      { link: "https://www.linkedin.com/jobs/view/1", source: "LinkedIn" },
      { link: "https://careers.acme.com/jobs/42", source: "Acme Careers" },
    ],
  };
  assert.equal(pickOfficialLink(job, "acme.com"), "https://careers.acme.com/jobs/42");
  assert.equal(pickOfficialLink(job, "beta.com"), null);
});

// ---------------------------------------------------------------------------
// Answer plan checks
// ---------------------------------------------------------------------------

const field = (f: Partial<FormField> & { key: string }): FormField => ({ selector: `#${f.key}`, type: "text", label: f.key, required: false, ...f });

test("buildPlan: drops invalid options, maps labels to values, asks for required unknowns", () => {
  const fields = [
    field({ key: "name", label: "Full name", required: true }),
    field({ key: "year", type: "select", label: "Graduation year", required: true, options: [{ value: "y27", label: "2027" }] }),
    field({ key: "mode", type: "radio", label: "Work mode", required: true, options: [{ value: "remote", label: "Remote" }] }),
    field({ key: "stipend", label: "Expected stipend", required: true }),
    field({ key: "ref", label: "Referral", required: false }),
    field({ key: "cv", type: "file", label: "Resume", required: true }),
    field({ key: "privacy", type: "checkbox", label: "I agree", required: true }),
  ];
  const plan = buildPlan(
    fields,
    [
      { key: "name", value: "Asha", source: "profile" },
      { key: "year", value: "2027", source: "profile" }, // label → value "y27"
      { key: "mode", value: "Hybrid", source: "profile" }, // not an option → must ask
      { key: "stipend", value: null, source: null },
      { key: "cv", value: "RESUME", source: "resume_file" },
      { key: "privacy", value: "true", source: "consent" },
      { key: "made-up", value: "x", source: "profile" }, // not a real field → ignored
    ],
    [{ key: "stipend", question: "What stipend do you expect?" }],
  );
  assert.deepEqual(
    plan.fills.map((f) => [f.key, f.value]),
    [["name", "Asha"], ["year", "y27"], ["cv", "RESUME"], ["privacy", "true"]],
  );
  assert.deepEqual(plan.questions.map((q) => q.key), ["mode", "stipend"]);
  assert.equal(plan.questions[1].question, "What stipend do you expect?");
  assert.deepEqual(plan.questions[0].options, [{ value: "remote", label: "Remote" }]);
});

test("planAnswers: a required sensitive field stops everything, with no AI call", async () => {
  const profile = { name: "Asha" } as unknown as Profile;
  const job = { title: "Intern", company: "Acme" } as Job;
  const plan = await planAnswers(profile, {}, job, [field({ key: "pan", label: "PAN card number", required: true })], undefined);
  assert.equal(plan.sensitive, "PAN card number");
  assert.equal(plan.fills.length, 0);
});

test("answerKey normalizes labels so answers can be reused", () => {
  assert.equal(answerKey("Expected monthly stipend (INR) *"), "expected monthly stipend inr");
  assert.equal(answerKey("expected  monthly stipend (inr)"), "expected monthly stipend inr");
});

/**
 * Test the Phase 3 browser agent end to end on your laptop, against a fake careers site:
 *
 *   npm run try-apply
 *
 * Starts a tiny local "company" website, then:
 *   1. A normal form: inspect → AI plans answers → answers the questions → submit → expect ✅
 *   2. A form that posts to ANOTHER domain: expect it to be blocked, not submitted
 *
 * Uses your Google Chrome (APPLY_RUNNER=local) and one or two AI calls. No Telegram, no Redis.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planAnswers } from "../src/apply/answers.js";
import { runAgent } from "../src/apply/runner.js";
import type { Profile } from "../src/profile.js";
import type { Job } from "../src/types.js";

process.env.APPLY_RUNNER = "local";
const PORT = 4777;
const template = readFileSync("test/fixtures/careers.html", "utf8");

// The fake company. "localhost" is its domain; 127.0.0.1 counts as a DIFFERENT site.
const received: string[] = [];
const server = createServer((req, res) => {
  if (req.method === "POST") {
    let size = 0;
    req.on("data", (chunk) => (size += chunk.length));
    req.on("end", () => {
      received.push(`${req.headers.host}${req.url} (${size} bytes)`);
      res.writeHead(200, { "Access-Control-Allow-Origin": "*" }).end("ok");
    });
    return;
  }
  const action = req.url?.includes("offsite") ? `http://127.0.0.1:${PORT}/apply` : "/apply";
  res.writeHead(200, { "Content-Type": "text/html" }).end(template.replaceAll("{{ACTION}}", action));
});
await new Promise<void>((r) => server.listen(PORT, r));

const profile: Profile = {
  name: "Aarav Mehta",
  email: "aarav.mehta@example.com",
  phone: "+91 90000 00000",
  city: "Bengaluru, Karnataka",
  headline: "Final-year CS student, React + TypeScript",
  education: [{ institution: "Example Institute of Technology", degree: "B.Tech", field: "Computer Science", graduationYear: 2027, grade: "8.6/10" }],
  skills: ["React", "TypeScript", "Next.js", "Node.js"],
  experience: [{ title: "Frontend Developer Intern", company: "Example Labs", start: "May 2026", end: "Jul 2026", summary: "Built React dashboard components." }],
  projects: [{ name: "CampusEats", summary: "Food pre-ordering app used by 600+ students." }],
  links: { linkedin: null, github: "github.com/example-aarav", portfolio: null },
  targetRoles: ["frontend developer intern"],
  preferredLocations: ["Bengaluru, Karnataka, India", "remote"],
};
const job: Job = {
  id: "demo",
  title: "Frontend Intern",
  company: "Example Corp",
  location: "Bengaluru",
  applyLink: "",
  applyLinks: [],
  summary: "Build React + TypeScript interfaces.",
};
// Pretend the student answers every question like this.
const studentReplies: Record<string, string> = { stipend: "15000", mode: "hybrid" };
const resume = { bytes: readFileSync("samples/demo-resume.pdf"), fileName: "Aarav_Mehta_Resume.pdf" };

async function scenario(name: string, path: string, expect: string) {
  const url = `http://localhost:${PORT}${path}`;
  console.log(`\n=== ${name} (${url}) ===`);

  const inspect = await runAgent({ mode: "inspect", url, domain: "localhost" });
  console.log(`inspect: ${inspect.result.status}, ${inspect.result.fields?.length ?? 0} fields, clickApply=${inspect.result.clickApply}`);
  if (!inspect.result.fields) return console.log("  blocker:", inspect.result.blocker);

  const plan = await planAnswers(profile, {}, job, inspect.result.fields);
  for (const f of plan.fills) console.log(`  fill  ${f.label.slice(0, 45).padEnd(45)} = ${f.value.slice(0, 60)}`);
  for (const q of plan.questions) console.log(`  ASK   ${q.label.slice(0, 45).padEnd(45)} → "${q.question}"`);

  // Answer the questions the way a student would.
  const fills = [...plan.fills];
  for (const q of plan.questions) {
    const reply = Object.entries(studentReplies).find(([k]) => q.key.includes(k))?.[1] ?? "N/A";
    fills.push({ key: q.key, selector: q.selector, type: q.type, label: q.label, value: reply });
  }

  const submit = await runAgent({ mode: "submit", url: inspect.result.url ?? url, domain: "localhost", clickApply: !!inspect.result.clickApply, fills }, resume);
  const shot = join(tmpdir(), `radar-${path.replace(/\W/g, "") || "form"}.png`);
  if (submit.screenshot) writeFileSync(shot, submit.screenshot);
  console.log(`submit: ${submit.result.status}${submit.result.reason ? `: ${submit.result.reason}` : ""}`);
  console.log(`blocked requests: ${submit.result.blockedRequests.join(", ") || "none"}`);
  console.log(`screenshot: ${shot}`);
  const pass = expect === "blocked" ? submit.result.status === "failed" && submit.result.blockedRequests.length > 0 : submit.result.status === expect;
  console.log(`expected: ${expect} → ${pass ? "✅ PASS" : "❌ FAIL"}`);
}

try {
  await scenario("Normal form on the company's own site", "/careers/frontend-intern", "submitted");
  await scenario("Form that sends data to another domain", "/careers/offsite", "blocked");
  console.log(`\nWhat the fake company server received: ${received.join(", ") || "nothing"}`);
} finally {
  server.close();
}

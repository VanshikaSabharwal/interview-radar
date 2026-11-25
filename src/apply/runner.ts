/**
 * Runs the browser agent (sandbox/agent.mjs) and returns its result + screenshot.
 *
 *   APPLY_RUNNER=local    run it on this machine (needs Chrome; great for testing)
 *   (default) sandbox     run it in a fresh Vercel Sandbox forked from a base sandbox
 *                         that already has Playwright + Chromium (see scripts/setup-sandbox.ts)
 *
 * Every application gets its own throwaway machine, so nothing from one company's
 * site can leak into another's.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbox } from "@vercel/sandbox";

export const BASE_SANDBOX = "radar-browser-base";
/** Folder inside the sandbox where Playwright is installed and the agent runs. */
export const SANDBOX_APP_DIR = "/vercel/sandbox/app";
const AGENT_PATH = join(process.cwd(), "sandbox", "agent.mjs");

/** A form field as the agent found it. */
export interface FormField {
  key: string;
  selector: string;
  type: string; // text, email, tel, url, number, date, textarea, select, radio, checkbox, file, ...
  label: string;
  required: boolean;
  options?: { value: string; label: string }[];
  accept?: string;
}

/** What to type/select into one field. */
export interface Fill {
  key: string;
  selector: string;
  type: string;
  label: string;
  value: string;
}

export type AgentInput =
  /** mustMention: the page must contain one of these company words (used when Google couldn't confirm the domain) */
  | { mode: "inspect"; url: string; domain: string; mustMention?: string[] }
  | { mode: "submit"; url: string; domain: string; clickApply: boolean; fills: Fill[] };

export interface AgentResult {
  status: "ok" | "blocked" | "submitted" | "needs_human" | "failed" | "unconfirmed" | "error";
  blocker?: "captcha" | "login" | "off_domain" | "off_domain_form" | "no_form" | "unverified";
  reason?: string;
  detail?: string;
  fields?: FormField[];
  clickApply?: boolean;
  url?: string;
  finalUrl: string;
  blockedRequests: string[];
  blockedNavigations: string[];
}

export interface AgentRun {
  result: AgentResult;
  screenshot: Buffer | null;
}

export async function runAgent(input: AgentInput, resume?: { bytes: Uint8Array; fileName: string }): Promise<AgentRun> {
  return process.env.APPLY_RUNNER === "local" ? runLocally(input, resume) : runInSandbox(input, resume);
}

async function runLocally(input: AgentInput, resume?: { bytes: Uint8Array; fileName: string }): Promise<AgentRun> {
  const dir = await mkdtemp(join(tmpdir(), "radar-agent-"));
  try {
    const resumePath = join(dir, safeFileName(resume?.fileName));
    if (resume) await writeFile(resumePath, resume.bytes);
    await writeFile(join(dir, "input.json"), JSON.stringify({ ...input, resumePath }));
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [AGENT_PATH, join(dir, "input.json"), join(dir, "out")], {
        stdio: "inherit",
        // Uses your installed Google Chrome, so `npx playwright install` isn't needed locally.
        env: { ...process.env, BROWSER_CHANNEL: process.env.BROWSER_CHANNEL ?? "chrome" },
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 150_000);
      child.on("exit", () => (clearTimeout(timer), resolve()));
      child.on("error", reject);
    });
    return await readOutputs((p) => readFile(join(dir, "out", p)).catch(() => null));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runInSandbox(input: AgentInput, resume?: { bytes: Uint8Array; fileName: string }): Promise<AgentRun> {
  const app = SANDBOX_APP_DIR; // the base sandbox installed Playwright here
  const resumePath = `${app}/${safeFileName(resume?.fileName)}`;

  // A fresh, non-persistent copy of the base sandbox, deleted when we're done.
  const sandbox = await Sandbox.fork({ sourceSandbox: BASE_SANDBOX, persistent: false, timeout: 5 * 60_000 });
  try {
    await sandbox.writeFiles([
      { path: `${app}/agent.mjs`, content: await readFile(AGENT_PATH) },
      { path: `${app}/input.json`, content: JSON.stringify({ ...input, resumePath }) },
      ...(resume ? [{ path: resumePath, content: resume.bytes }] : []),
    ]);
    const run = await sandbox.runCommand({ cmd: "node", args: ["agent.mjs", "input.json", "out"], cwd: app });
    if (run.exitCode !== 0) console.error("[agent] exited with", run.exitCode, (await run.stderr()).slice(-1000));
    return await readOutputs((p) => sandbox.readFileToBuffer({ path: `${app}/out/${p}` }));
  } finally {
    await sandbox.delete().catch((e) => console.error("[agent] sandbox cleanup failed:", e));
  }
}

async function readOutputs(read: (path: string) => Promise<Buffer | null>): Promise<AgentRun> {
  const json = await read("result.json");
  const result: AgentResult = json
    ? JSON.parse(json.toString("utf8"))
    : { status: "error", reason: "The browser didn't return a result.", finalUrl: "", blockedRequests: [], blockedNavigations: [] };
  return { result, screenshot: await read("screenshot.png") };
}

/** Keep the original file name (companies see it), but only safe characters. */
function safeFileName(name = "resume.pdf"): string {
  const cleaned = name.replace(/[^\w.\- ]+/g, "_").slice(0, 80);
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
}

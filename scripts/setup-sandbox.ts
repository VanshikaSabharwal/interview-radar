/**
 * One-time setup: create the base Vercel Sandbox that every application is forked from.
 *
 *   vercel link && vercel env pull     # gives this script a Vercel login (VERCEL_OIDC_TOKEN in .env.local)
 *   npm run setup-sandbox
 *
 * It installs Playwright + Chromium once, checks the browser starts, then stops the
 * sandbox so Vercel saves a snapshot. Each application forks that snapshot, so
 * nothing has to be installed per application.
 *
 * Re-run it after upgrading Playwright. `-- --fresh` deletes the old base first.
 */
import { readFileSync } from "node:fs";
import { Sandbox } from "@vercel/sandbox";
import { BASE_SANDBOX, SANDBOX_APP_DIR as APP } from "../src/apply/runner.js";
const playwrightVersion = JSON.parse(readFileSync("node_modules/playwright/package.json", "utf8")).version as string;

async function run(sandbox: Sandbox, label: string, cmd: string, args: string[], sudo = false) {
  console.log(`→ ${label}`);
  const result = await sandbox.runCommand({ cmd, args, cwd: APP, sudo });
  if (result.exitCode !== 0) {
    console.error(await result.stderr());
    throw new Error(`${label} failed (exit ${result.exitCode})`);
  }
}

if (process.argv.includes("--fresh")) {
  const old = await Sandbox.get({ name: BASE_SANDBOX }).catch(() => null);
  if (old) {
    console.log(`Deleting old ${BASE_SANDBOX}…`);
    await old.delete({ deleteOrphanSnapshots: true });
  }
}

const sandbox = await Sandbox.getOrCreate({
  name: BASE_SANDBOX,
  region: "bom1", // Mumbai: Indian careers sites see an Indian visitor
  timeout: 15 * 60_000,
  snapshotExpiration: 0, // keep the base snapshot forever (forks need it)
  keepLastSnapshots: { count: 1 },
  onCreate: async (sbx) => {
    // `mkdir -p` also creates missing parent folders (on the current image, /vercel/sandbox doesn't exist yet).
    const mkdir = await sbx.runCommand({ cmd: "mkdir", args: ["-p", APP] });
    if (mkdir.exitCode !== 0) throw new Error(`mkdir failed: ${await mkdir.stderr()}`);
    await run(sbx, "npm init", "npm", ["init", "-y"]);
    await run(sbx, `install playwright@${playwrightVersion}`, "npm", ["install", `playwright@${playwrightVersion}`]);
    await run(sbx, "install Chromium's system libraries (sudo)", "npx", ["playwright", "install-deps", "chromium"], true);
    await run(sbx, "download Chromium", "npx", ["playwright", "install", "chromium"]);
  },
});

// Smoke test: can the browser start and load a page?
await sandbox.writeFiles([
  {
    path: `${APP}/smoke.mjs`,
    content: `import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage();
await p.goto("https://example.com");
console.log("title:", await p.title());
await b.close();`,
  },
]);
await run(sandbox, "smoke test: open example.com in Chromium", "node", ["smoke.mjs"]);

const stopped = await sandbox.stop();
console.log(`\n✅ Base sandbox "${BASE_SANDBOX}" is ready (snapshot ${stopped.snapshot?.id ?? "saved"}).`);
console.log("Applications will now fork it. Deploy, or run the bot locally without APPLY_RUNNER=local to use it.");

/**
 * Check that every service accepts your keys: `npm run check`
 * Costs 1 SearchApi credit and one tiny AI call.
 */
import { generateText } from "ai";
import { model } from "../src/ai.js";
import { redis } from "../src/redis.js";
import { fetchJobs } from "../src/searchapi.js";
import { telegram } from "../src/telegram.js";

let ok = true;
async function check(name: string, fn: () => Promise<string>) {
  try {
    console.log(`✅ ${name}: ${await fn()}`);
  } catch (error) {
    ok = false;
    console.log(`❌ ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

await check("Telegram", async () => `bot is @${(await telegram<{ username: string }>("getMe")).username}`);
await check("Upstash Redis", async () => `ping → ${await redis().ping()}`);
await check("Groq AI", async () => `replied "${(await generateText({ model, prompt: "Reply with just the word: ok" })).text.trim()}"`);
await check("SearchApi", async () => {
  const jobs = await fetchJobs({ query: "frontend intern", location: "Bengaluru, Karnataka, India" });
  return `${jobs.length} jobs for "frontend intern" in Bengaluru`;
});

if (!ok) process.exitCode = 1;

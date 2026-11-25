/**
 * Run the daily matching once from your machine.
 *
 *   npm run once               # real run: sends matches to every active student
 *   npm run once -- --dry-run  # prints matches; sends nothing, marks nothing as seen
 */
import { runDaily } from "../src/pipeline.js";

const dryRun = process.argv.includes("--dry-run");

try {
  const summary = await runDaily({ dryRun });
  console.log("\nSummary:", summary);
} catch (error) {
  console.error("\nRun failed:", error);
  process.exitCode = 1;
}

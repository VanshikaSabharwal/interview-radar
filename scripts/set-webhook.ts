/**
 * Point Telegram at your deployed bot: `npm run set-webhook -- https://your-app.vercel.app`
 */
import { requireEnv } from "../src/env.js";
import { setupBotProfile, telegram } from "../src/telegram.js";

const baseUrl = process.argv[2]?.replace(/\/$/, "");
if (!baseUrl?.startsWith("https://")) {
  console.error("Usage: npm run set-webhook -- https://your-app.vercel.app");
  process.exit(1);
}

await telegram("setWebhook", {
  url: `${baseUrl}/api/telegram`,
  secret_token: requireEnv("TELEGRAM_WEBHOOK_SECRET"),
  allowed_updates: ["message", "callback_query"],
  drop_pending_updates: true,
});
await setupBotProfile();
console.log("✅ Webhook set:", await telegram("getWebhookInfo"));

/**
 * Run the bot on your laptop, no deploy needed: `npm run bot`
 *
 * Uses long polling (getUpdates): we keep asking Telegram "anything new?"
 * and pass each update to the same handleUpdate() the webhook uses.
 *
 * Note: Telegram allows either a webhook OR polling. This script removes the
 * webhook, so run `npm run set-webhook` again after testing locally.
 */
import { handleUpdate, type TgUpdate } from "../src/bot.js";
import { setupBotProfile, telegram } from "../src/telegram.js";

await telegram("deleteWebhook");
await setupBotProfile();
const me = await telegram<{ username: string }>("getMe");
console.log(`🤖 @${me.username} is running locally. Message it in Telegram. (Ctrl+C to stop)`);

let offset = 0;
while (true) {
  try {
    // Waits up to 30s for new updates, then returns (possibly empty).
    const updates = await telegram<TgUpdate[]>("getUpdates", {
      offset,
      timeout: 30,
      allowed_updates: ["message", "callback_query"],
    });
    for (const update of updates) {
      offset = update.update_id + 1; // confirm it, so Telegram doesn't send it again
      console.log(`[dev] update ${update.update_id}: ${update.message?.text ?? (update.message?.document ? "📎 document" : update.callback_query?.data)}`);
      // Don't wait: an application can take a minute or two, and other messages
      // shouldn't queue behind it. (handleUpdate never throws.)
      void handleUpdate(update);
    }
  } catch (error) {
    console.error("[dev] polling error, retrying in 3s:", error);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

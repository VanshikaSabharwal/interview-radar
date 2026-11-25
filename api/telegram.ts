/**
 * POST /api/telegram: Telegram's webhook. Every message or button tap arrives here.
 *
 * Security: when we register the webhook (scripts/set-webhook.ts) we give Telegram
 * a secret, and Telegram sends it back in a header on every call. Requests
 * without it are rejected, so nobody can pretend to be Telegram.
 *
 * Speed: Telegram re-sends an update if we answer too slowly, so we reply
 * "ok" immediately and keep working in the background with waitUntil.
 */
import { waitUntil } from "@vercel/functions";
import { handleUpdate, type TgUpdate } from "../src/bot.js";

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const update = (await request.json()) as TgUpdate;
  waitUntil(handleUpdate(update));
  return new Response("ok");
}

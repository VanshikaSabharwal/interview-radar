/**
 * A small client for the Telegram Bot API calls we use.
 * Docs: https://core.telegram.org/bots/api
 */
import { requireEnv } from "./env.js";

/** We send HTML, so <, > and & in user-provided text must be escaped. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Call any Bot API method. Throws with Telegram's own error description. */
export async function telegram<T = unknown>(method: string, body: object = {}): Promise<T> {
  const token = requireEnv("TELEGRAM_BOT_TOKEN");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // getUpdates long-polls for up to 30s, so allow a little more than that.
    signal: AbortSignal.timeout(40_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    // Never log the URL: it contains the bot token.
    throw new Error(`Telegram ${method} HTTP ${res.status}: ${data.description ?? res.statusText}`);
  }
  return data.result as T;
}

/** An inline keyboard: rows of buttons, each sending `data` back to the bot when tapped. */
export type Buttons = { text: string; data: string }[][];

const keyboard = (buttons: Buttons) => ({
  inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))),
});

export async function sendMessage(chatId: number | string, text: string, buttons?: Buttons): Promise<void> {
  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    // Without this, Telegram would show a big preview card for the first link.
    link_preview_options: { is_disabled: true },
    reply_markup: buttons && keyboard(buttons),
  });
}

/** Send an image (e.g. a screenshot of the submitted form) with a short caption (max 1024 chars). */
export async function sendPhoto(chatId: number, png: Uint8Array, caption: string): Promise<void> {
  const token = requireEnv("TELEGRAM_BOT_TOKEN");
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("caption", caption.slice(0, 1024));
  form.set("parse_mode", "HTML");
  form.set("photo", new Blob([new Uint8Array(png)], { type: "image/png" }), "screenshot.png");
  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(`Telegram sendPhoto HTTP ${res.status}: ${data.description ?? res.statusText}`);
}

/** Replace the buttons under a message we sent earlier (e.g. after "Apply" is tapped). */
export async function editButtons(chatId: number, messageId: number, buttons: Buttons): Promise<void> {
  await telegram("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: keyboard(buttons) });
}

/**
 * Shown on the bot's empty chat screen, before the student taps Start
 * (same as BotFather's /setdescription). Telegram's limit: 512 characters.
 */
export const BOT_DESCRIPTION =
  "🎯 Your personal internship & job assistant.\n\n" +
  "📎 Send your resume (PDF) and I build your profile\n" +
  "🔎 Every morning I find roles that match you\n" +
  "✅ Tap Apply, and I apply on the company's official site\n\n" +
  "🔒 /delete erases your data anytime.\n" +
  "⚠️ Never share passwords, OTPs, Aadhaar/PAN or bank details here. I will never ask for them.\n" +
  "🧪 A free hobby project in beta: I use AI and can make mistakes. No guarantees.\n\n" +
  "Tap Start to begin!";

/** Shown on the bot's profile page and in shared links (BotFather's /setabouttext). Limit: 120 characters. */
export const BOT_SHORT_DESCRIPTION = "Hobby project: send your resume, get matching internships daily, apply on official sites. Beta.";

/** Set the bot's command menu and descriptions, so nothing has to be typed into BotFather by hand. */
export async function setupBotProfile(): Promise<void> {
  await telegram("setMyDescription", { description: BOT_DESCRIPTION });
  await telegram("setMyShortDescription", { short_description: BOT_SHORT_DESCRIPTION });
  await telegram("setMyCommands", {
    commands: [
      { command: "jobs", description: "Find matching jobs now" },
      { command: "saved", description: "Your applications and their status" },
      { command: "profile", description: "See or fix your profile" },
      { command: "demo", description: "Watch a test application (no real company)" },
      { command: "autofill", description: "A bookmark that fills your details into forms" },
      { command: "terms", description: "Terms and privacy policy" },
      { command: "delete", description: "Erase all your data" },
      { command: "help", description: "What I can do" },
    ],
  });
}

/** Download a file a user sent to the bot. */
export async function downloadFile(fileId: string): Promise<Uint8Array> {
  const file = await telegram<{ file_path: string }>("getFile", { file_id: fileId });
  const token = requireEnv("TELEGRAM_BOT_TOKEN");
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Telegram file download HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { BOT_DESCRIPTION, BOT_SHORT_DESCRIPTION, escapeHtml } from "../src/telegram.js";

test("bot descriptions fit Telegram's limits", () => {
  // JS counts emoji as 2 characters, so this check is slightly stricter than Telegram's.
  assert.ok(BOT_DESCRIPTION.length <= 512, `description is ${BOT_DESCRIPTION.length} chars`);
  assert.ok(BOT_SHORT_DESCRIPTION.length <= 120, `short description is ${BOT_SHORT_DESCRIPTION.length} chars`);
});

test("escapeHtml escapes HTML special characters", () => {
  assert.equal(escapeHtml(`R&D <Intern> "x"`), "R&amp;D &lt;Intern&gt; &quot;x&quot;");
});

/**
 * Phase 3 browser agent. Runs in a Vercel Sandbox (or on your laptop for testing).
 *
 *   node agent.mjs input.json out/
 *
 * Two modes:
 *   inspect: open the careers page, find the application form, list its fields,
 *            and detect anything that needs a human (captcha, login, form on another site).
 *   submit:  open the page again, fill the fields, attach the resume, submit,
 *            and report honestly whether it worked.
 *
 * Safety rule enforced here: the browser may only SEND data to the company's own
 * domain. Any POST/PUT to another domain, and any navigation away from the company's
 * site, is blocked.
 *
 * Writes out/result.json and out/screenshot.png. Plain JavaScript (no build step),
 * because it is copied into the sandbox and run with `node` as-is.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const [inputPath, outDir = "out"] = process.argv.slice(2);
const input = JSON.parse(readFileSync(inputPath, "utf8"));
mkdirSync(outDir, { recursive: true });

/** Is this URL on the company's own domain (or a subdomain of it)? */
function onCompanySite(url) {
  try {
    const host = new URL(url).hostname;
    return host === input.domain || host.endsWith(`.${input.domain}`);
  } catch {
    return false;
  }
}

const blockedRequests = []; // e.g. "POST api.some-ats.com"
const blockedNavigations = []; // hosts we refused to navigate to

const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || undefined });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-IN" });
const page = await context.newPage();

// The guard: block data leaving for other domains, and navigations off the company site.
await context.route("**/*", (route) => {
  const req = route.request();
  const url = req.url();
  if (!url.startsWith("http")) return route.continue();
  const sendsData = !["GET", "HEAD", "OPTIONS"].includes(req.method());
  const leavesSite = req.isNavigationRequest() && req.frame() === page.mainFrame() && !onCompanySite(url);
  if (leavesSite) {
    blockedNavigations.push(new URL(url).hostname);
    return route.abort("blockedbyclient");
  }
  if (sendsData && !onCompanySite(url)) {
    blockedRequests.push(`${req.method()} ${new URL(url).hostname}`);
    return route.abort("blockedbyclient");
  }
  return route.continue();
});

async function finish(result) {
  await page.screenshot({ path: join(outDir, "screenshot.png") }).catch(() => {});
  writeFileSync(join(outDir, "result.json"), JSON.stringify({ ...result, finalUrl: page.url(), blockedRequests, blockedNavigations }));
  await browser.close();
  process.exit(0);
}

/** Wait for the page to calm down, but never too long. */
async function settle(ms = 8000) {
  await page.waitForLoadState("networkidle", { timeout: ms }).catch(() => {});
}

/** Open the page, and click "Apply" first if the form sits behind that button. */
async function openForm() {
  await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await settle();
  if (input.clickApply) await clickApplyButton();
}

async function clickApplyButton() {
  const apply = page
    .getByRole("button", { name: /apply/i })
    .or(page.getByRole("link", { name: /apply/i }))
    .first();
  if ((await apply.count()) === 0) return false;
  await apply.click({ timeout: 5000 }).catch(() => {});
  await settle();
  return true;
}

/** Does the page need a human? Returns "captcha", "login" or null. */
async function findBlocker() {
  const captcha = page.locator(
    'iframe[src*="recaptcha"]:not([src*="size=invisible"]), iframe[src*="hcaptcha"], iframe[src*="turnstile"], .h-captcha, .cf-turnstile',
  );
  if ((await captcha.filter({ visible: true }).count()) > 0) return "captcha";
  if ((await page.locator('input[type="password"]').filter({ visible: true }).count()) > 0) return "login";
  return null;
}

/** List the form fields on the page: label, type, required, options. Runs inside the page. */
function scanFields() {
  const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const labelOf = (el) => {
    const parts = [];
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) parts.push(l.innerText);
    }
    const wrap = el.closest("label");
    if (wrap) parts.push(wrap.innerText);
    for (const id of (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)) {
      const n = document.getElementById(id);
      if (n) parts.push(n.innerText);
    }
    if (el.getAttribute("aria-label")) parts.push(el.getAttribute("aria-label"));
    if (el.placeholder) parts.push(el.placeholder);
    if (!parts.length) parts.push(el.closest("fieldset")?.querySelector("legend")?.innerText || el.name || "");
    return clean([...new Set(parts.map(clean))].join(" ")).slice(0, 200);
  };

  const fields = [];
  const seenGroups = new Set();
  for (const el of document.querySelectorAll("input, select, textarea")) {
    const tag = el.tagName.toLowerCase();
    const type = tag === "input" ? (el.type || "text").toLowerCase() : tag;
    if (["hidden", "submit", "button", "reset", "image", "search", "password"].includes(type)) continue;
    if (el.disabled || el.readOnly) continue;
    // File inputs are often hidden behind a styled button, so for them it's enough that
    // the surrounding element is visible. (A form still hidden behind "Apply" doesn't count.)
    const shown = isVisible(el) || (type === "file" && el.parentElement && isVisible(el.parentElement));
    if (!shown) continue;

    if (type === "radio") {
      if (!el.name || seenGroups.has(el.name)) continue;
      seenGroups.add(el.name);
      const radios = [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)];
      const legend = el.closest("fieldset")?.querySelector("legend")?.innerText;
      const group = el.closest('[role="radiogroup"]')?.getAttribute("aria-label");
      fields.push({
        key: `radio:${el.name}`,
        selector: `input[type="radio"][name="${CSS.escape(el.name)}"]`,
        type: "radio",
        label: clean(legend || group || el.name).slice(0, 200),
        required: radios.some((r) => r.required),
        options: radios.map((r) => ({ value: r.value, label: labelOf(r) })),
      });
      continue;
    }

    // We must be able to find the field again in the submit run, so it needs an id or a name.
    const selector = el.id ? `#${CSS.escape(el.id)}` : el.name ? `${tag}[name="${CSS.escape(el.name)}"]` : null;
    if (!selector) continue;
    const label = labelOf(el);
    const field = {
      key: selector,
      selector,
      type,
      label,
      required: el.required || el.getAttribute("aria-required") === "true" || /\*\s*$/.test(label),
    };
    if (type === "select") field.options = [...el.options].filter((o) => o.value !== "").map((o) => ({ value: o.value, label: clean(o.text) }));
    if (type === "file") field.accept = el.accept || "";
    fields.push(field);
  }
  return fields.slice(0, 60);
}

async function inspect() {
  await openForm();
  if (!onCompanySite(page.url())) return finish({ status: "blocked", blocker: "off_domain" });

  let fields = await page.evaluate(scanFields);
  let clickApply = false;
  if (fields.length === 0 && (await clickApplyButton())) {
    clickApply = true;
    fields = await page.evaluate(scanFields);
  }

  if (blockedNavigations.length > 0) return finish({ status: "blocked", blocker: "off_domain_form", detail: blockedNavigations[0] });
  const blocker = await findBlocker();
  if (blocker) return finish({ status: "blocked", blocker });
  if (fields.length === 0) return finish({ status: "blocked", blocker: "no_form" });
  return finish({ status: "ok", fields, clickApply, url: page.url() });
}

async function fillField(fill) {
  const field = page.locator(fill.selector).first();
  switch (fill.type) {
    case "select":
      await field.selectOption({ value: fill.value }, { timeout: 5000 });
      return;
    case "radio":
      await page.locator(`${fill.selector}[value="${CSS_escape(fill.value)}"]`).first().check({ timeout: 5000 });
      return;
    case "checkbox":
      if (fill.value === "true") await field.check({ timeout: 5000 });
      return;
    case "file":
      await field.setInputFiles(input.resumePath, { timeout: 5000 });
      return;
    default:
      await field.fill(fill.value, { timeout: 5000 });
  }
}

/** Minimal escaping for a value inside a CSS attribute selector (Node has no CSS.escape). */
function CSS_escape(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

/**
 * The form's real submit button. Checked in order, first visible match wins:
 *  1. a submit button inside a form (a <button> without a type submits too)
 *  2. any submit button on the page
 *  3. a button labelled "Submit…" / "Send application" (NOT a plain "Apply", which usually just opens the form)
 */
async function findSubmitButton() {
  const candidates = [
    page.locator('form button[type="submit"], form input[type="submit"], form button:not([type])'),
    page.locator('button[type="submit"], input[type="submit"]'),
    page.getByRole("button", { name: /submit|send application|apply now and submit/i }),
  ];
  for (const candidate of candidates) {
    const visible = candidate.filter({ visible: true });
    if ((await visible.count()) > 0) return visible.last();
  }
  return null;
}

const SUCCESS =/thank you for (applying|your application)|thanks for applying|application (has been |was )?(received|submitted)|successfully (submitted|applied)|we('ve| have) received your application/i;
const NEEDS_CODE = /verification code|one[- ]time password|\botp\b|verify your (email|phone)/i;

async function submit() {
  await openForm();
  if (!onCompanySite(page.url())) return finish({ status: "failed", reason: "The page left the company's website." });

  const problems = [];
  for (const fill of input.fills) {
    try {
      await fillField(fill);
    } catch (error) {
      problems.push(fill.label || fill.key);
    }
  }
  if (problems.length) return finish({ status: "failed", reason: `I couldn't fill: ${problems.slice(0, 5).join(", ")}` });

  const blocker = await findBlocker();
  if (blocker) return finish({ status: "needs_human", reason: blocker });

  const button = await findSubmitButton();
  if (!button) return finish({ status: "failed", reason: "I couldn't find the submit button." });

  const urlBefore = page.url();
  await button.click({ timeout: 10_000 });

  // Watch for up to 15s: a confirmation, a code request, a page change, or a blocked request.
  // (Waiting for "network idle" isn't enough: it may already count as reached from before the click.)
  const bodyText = async () => (await page.locator("body").innerText().catch(() => "")).slice(0, 20_000);
  let text = "";
  for (let waited = 0; waited < 15_000; waited += 500) {
    await page.waitForTimeout(500);
    text = await bodyText();
    if (SUCCESS.test(text) || NEEDS_CODE.test(text) || blockedRequests.length || blockedNavigations.length) break;
    if (page.url() !== urlBefore) {
      await settle();
      text = await bodyText();
      break;
    }
  }
  if (blockedRequests.length || blockedNavigations.length) {
    // The form tried to send the application to another website. We stopped it.
    const host = blockedRequests[0]?.split(" ")[1] ?? blockedNavigations[0];
    return finish({ status: "failed", reason: `The form tried to send your data to ${host}, which isn't the company's own site, so I stopped it.` });
  }
  if (SUCCESS.test(text)) return finish({ status: "submitted" });
  if (NEEDS_CODE.test(text)) return finish({ status: "needs_human", reason: "otp" });
  if (await findBlocker()) return finish({ status: "needs_human", reason: "captcha" });

  const invalid = await page.locator(":invalid").filter({ visible: true }).count().catch(() => 0);
  if (invalid > 0) return finish({ status: "failed", reason: "The form says some answers are missing or invalid." });

  // No clear "thank you". Don't claim success.
  const changed = page.url() !== urlBefore;
  return finish({ status: "unconfirmed", reason: changed ? "The page changed after submitting, but showed no confirmation." : "I clicked submit but saw no confirmation." });
}

try {
  if (input.mode === "inspect") await inspect();
  else if (input.mode === "submit") await submit();
  else throw new Error(`Unknown mode ${input.mode}`);
} catch (error) {
  await finish({ status: "error", reason: String(error?.message ?? error).slice(0, 300) });
}

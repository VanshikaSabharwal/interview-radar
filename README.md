# 🎯 Internship Radar

A Telegram bot that job-hunts for students. Send it your resume once. Every morning it finds internships that fit you, and when you tap **✅ Apply** it applies on the **company's own careers website**, asking you only when it really needs you.

> A personal hobby project. Free, provided as is, no guarantees.

```
You:  📎 resume.pdf
Bot:  Here's what I understood… [✅ Looks right] [✏️ Fix something]
Bot:  Frontend Intern — Jupiter Money · ⭐ 90% match   [✅ Apply] [⏭ Skip]
You:  ✅ Apply
Bot:  ❓ Jupiter Money asks: What monthly stipend do you expect?
You:  15000
Bot:  ✅ Applied on jupiter.money, the company's own site. [screenshot]
```

## What it does

| Phase | Feature |
| --- | --- |
| 0 | **Consent first.** Nothing is stored until the student agrees to the terms (versioned; re-asked when they change). |
| 1 | **Resume → profile.** The PDF's text is turned into a structured profile by AI. Unknown fields stay empty, never guessed. Fix it in plain words. |
| 2 | **Daily matches.** Searches Google Jobs from the student's roles × locations, dedupes, skips already-seen jobs, scores them with AI, and sends the best few with Apply/Skip. |
| 3 | **Applies on official sites only.** Finds the company's own domain, checks the apply link is on it, then fills and submits the form in a sandboxed browser. Asks for missing required info (and remembers it). Hands off with the link and prepared answers when a human is needed. |

### Safety rules built into Phase 3

- **Company's own website only.** The apply link must be on the company's domain or a subdomain (`careers.acme.com`). Job boards, LinkedIn and hiring platforms (Lever, Greenhouse, Workday…) are always handed off.
- **Enforced inside the browser too.** Any request that would send data to another domain, and any navigation off the company's site, is blocked. `npm run try-apply` checks this.
- **Never makes things up.** Answers come from the profile or from what the student said. Select/radio answers are checked against the real options.
- **Never handles sensitive data.** If a required field asks for Aadhaar, PAN, bank details, passwords or OTPs, the bot hands off instead of asking.
- **Never solves captchas, logs in, or enters OTPs.** Those are handed off.
- **Honest results.** "✅ Applied" only when a confirmation is seen; otherwise "couldn't confirm", with a screenshot either way.
- **One throwaway machine per application** (a Vercel Sandbox fork), deleted afterwards.

## Project structure

```
radar.config.ts        limits, thresholds, terms version, site URL
src/
  bot.ts               conversation: consent, commands, resume upload, buttons
  resume.ts · profile.ts   PDF → text → AI → profile
  matching.ts · pipeline.ts  searches, AI scoring, daily run
  apply/
    apply.ts           the application flow (official site → inspect → answers → questions → submit / hand off)
    official.ts        finding the company's official domain, link checks
    answers.ts         AI form answers + validation against the real form
    runner.ts          runs the browser agent locally or in Vercel Sandbox
  searchapi.ts · dedupe.ts · students.ts · jobs.ts · telegram.ts · ai.ts · redis.ts
sandbox/agent.mjs      Playwright browser agent (inspect / submit), with the domain guard
public/                terms + privacy pages (linked from the bot's consent step); "/" redirects to the bot
api/telegram.ts        Telegram webhook   api/run.ts   daily run
scripts/               bot, check, try-resume, try-apply, setup-sandbox, set-webhook, once
test/                  unit tests + a fake careers site (test/fixtures)
```

## Setup

Node.js 22+ (`nvm use` picks 24 from `.nvmrc`).

```bash
npm install
cp .env.example .env      # fill in the keys below
npm run check             # checks Telegram, Redis, Groq, SearchApi
npm test
```

| Variable | Where to get it |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | @BotFather → `/newbot` |
| `TELEGRAM_WEBHOOK_SECRET`, `CRON_SECRET` | `openssl rand -hex 32` (one each) |
| `GROQ_API_KEY` | [console.groq.com/keys](https://console.groq.com/keys) |
| `SEARCHAPI_API_KEY` | [searchapi.io](https://www.searchapi.io/) |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | [console.upstash.com](https://console.upstash.com/) → Redis → REST API |
| `APPLY_RUNNER` | `local` to fill forms with your own Chrome while testing; unset = Vercel Sandbox |

## Test locally

```bash
npm run try-resume                  # demo resume → profile → searches → matches (no Telegram)
npm run try-apply                   # applies to a fake careers site with your Chrome, incl. the domain guard
APPLY_RUNNER=local npm run bot      # the full bot on your laptop; message @YourBot in Telegram
```

A fictional resume to test with is in [`samples/demo-resume.pdf`](samples/demo-resume.pdf).

## Deploy (Vercel)

One Vercel project serves the terms/privacy pages (`public/`), the webhook, the daily run, and the sandboxes. Share the bot as `https://t.me/InternshipRadarr_bot`; your Vercel domain's root also redirects there.

```bash
npm i -g vercel@latest
vercel link                       # create/link the project
vercel env pull                   # writes .env.local with a Vercel login, used by the Sandbox SDK locally
npm run setup-sandbox             # one time: base sandbox with Playwright + Chromium (Mumbai region)
```

Then:

1. Add every variable from `.env` in **Vercel → Project → Settings → Environment Variables** (Production), except `APPLY_RUNNER`.
2. Deploy: `vercel deploy --prod`, or push to GitHub with the repo connected.
3. Point Telegram at it: `npm run set-webhook -- https://<your-app>.vercel.app`
4. Check `https://<your-app>.vercel.app/terms` and `/privacy` load (the bot's consent message links to them).
5. Replace `CONTACT_EMAIL` in `public/terms.html` and `public/privacy.html` with a contact address, and redeploy.

The daily run is a [Vercel Schedule](https://vercel.com/docs/schedules) in `vercel.json` (03:30 UTC = 09:00 IST). Trigger it by hand with `vercel schedules invoke daily-digest`.

## Free-tier limits to know

- **Groq free tier:** ~8,000 tokens/minute, so the daily run handles one student at a time (`concurrency: 1`).
- **SearchApi:** up to 4 searches per student per day, plus 1 per new company for the official-site check (cached 30 days).
- **Vercel Sandbox (Hobby):** about 5 active-CPU hours a month. Each application uses two short browser runs. Students are limited to 10 applications a day.
- **Function time:** an application must finish within 300 s; most take 1–2 minutes.

## License

[MIT](LICENSE)

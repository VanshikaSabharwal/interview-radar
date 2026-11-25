/**
 * Phase 3: apply to a job the student chose.
 *
 *   ✅ Apply tapped
 *     → find the company's official domain          (official.ts)
 *     → is the apply link on that domain?            no → hand off
 *     → open the form in a sandboxed browser         (runner.ts → agent.mjs "inspect")
 *         captcha / login / form elsewhere?          yes → hand off
 *     → AI fills fields from the profile             (answers.ts)
 *         sensitive field?                           yes → hand off
 *         required field unknown?                    yes → ask the student, one question at a time
 *     → fill + submit in a fresh sandboxed browser   (agent.mjs "submit")
 *     → ✅ applied (with screenshot), or hand off with the link + answers
 *
 * "Hand off" = the student gets the link and every answer we prepared, and applies themselves.
 */
import { config } from "../../radar.config.js";
import { type Application, getApplication, getJob, listApplications, saveApplication } from "../jobs.js";
import { claimAwaiting, clearAwaiting, getAnswers, getAwaiting, saveAnswer, type Student, withinDailyLimit } from "../students.js";
import { downloadFile, editButtons, escapeHtml, sendMessage, sendPhoto } from "../telegram.js";
import type { Job } from "../types.js";
import { answerKey, planAnswers } from "./answers.js";
import { autofillData, detailLines } from "./details.js";
import { companyKeywords, domainOf, findOfficialDomain, isCompanySiteCandidate, pickOfficialLink } from "./official.js";
import { type AgentResult, runAgent } from "./runner.js";

/** Called when the student taps ✅ Apply. */
export async function startApplication(student: Student, jobId: string, messageId?: number): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return sendMessage(student.chatId, "That job has expired. Tap /jobs for fresh matches.");
  if (!student.profile || !student.resume) return sendMessage(student.chatId, "📎 Please send your resume first.");

  const existing = await getApplication(student.userId, jobId);
  if (existing && existing.status !== "cancelled") {
    return sendMessage(student.chatId, `You already started this one: ${STATUS_TEXT[existing.status]}. See /saved.`);
  }
  if (!(await withinDailyLimit(student.userId, "apply", config.limits.applications))) {
    return sendMessage(student.chatId, `You've reached today's limit of ${config.limits.applications} applications. Try again tomorrow.`);
  }

  const app: Application = { jobId, status: "applying", updatedAt: "", messageId };
  await saveApplication(student.userId, app);
  await showStatus(student, app);

  try {
    // 1. The company's official website. (The /demo job's "company" is this project's own demo page.)
    //    Google confirms it for most companies. Small ones often don't show up, so then we fall back to
    //    the listing's own domain (it already looks like the company's name and isn't a job board), and
    //    the browser must find the company's name on that page before we go any further.
    const confirmed = job.demoDomain ?? (await findOfficialDomain(job.company));
    const listingDomain = job.officialLink ? domainOf(job.officialLink) : null;
    const domain = confirmed ?? (isCompanySiteCandidate(listingDomain, job.company) ? listingDomain : null);
    if (!domain) return handOff(student, app, job, `I couldn't confirm ${job.company}'s official website, so I won't apply for you.`);
    const url = pickOfficialLink(job, domain);
    if (!url) {
      return handOff(student, app, job, `This listing isn't on ${job.company}'s own website (${domain}). I only apply on official company sites.`);
    }

    // 2. Look at the form.
    await sendMessage(student.chatId, `🔎 Opening <b>${escapeHtml(job.company)}</b>'s careers page on <b>${escapeHtml(domain)}</b>…`);
    const { result } = await runAgent({
      mode: "inspect",
      url,
      domain,
      ...(confirmed ? {} : { mustMention: companyKeywords(job.company) }),
    });
    if (result.status !== "ok" || !result.fields) return handOff(student, app, job, explainBlocker(result, job), url);

    // 3. Plan the answers.
    const plan = await planAnswers(student.profile, await getAnswers(student.userId), job, result.fields);
    if (plan.sensitive) {
      return handOff(student, app, job, `The form asks for "${plan.sensitive}". I never handle details like that, so please fill this one in yourself.`, url);
    }
    const fileQuestion = plan.questions.find((q) => q.type === "file");
    if (fileQuestion) return handOff(student, app, job, `The form needs a file I don't have: "${fileQuestion.label}".`, url);

    Object.assign(app, { url: result.url ?? url, domain, clickApply: !!result.clickApply, fills: plan.fills, questions: plan.questions, written: plan.written });

    // 4. Ask for what's missing, or go straight to submitting.
    if (plan.questions.length > 0) {
      app.status = "needs_info";
      await saveApplication(student.userId, app);
      await showStatus(student, app);
      return askNextQuestion(student, app, job);
    }
    await submitApplication(student, app, job);
  } catch (error) {
    console.error(`[apply] user ${student.userId} job ${jobId} failed:`, error);
    await handOff(student, app, job, "Something went wrong on my side while applying.", app.url);
  }
}

/** Ask the first open question of this application, unless another application is already asking. */
async function askNextQuestion(student: Student, app: Application, job: Job): Promise<void> {
  const question = app.questions?.[0];
  if (!question) return;
  if (!(await claimAwaiting(student.userId, app.jobId))) {
    // Another application is asking right now; this one waits its turn (see askPendingQuestions).
    return;
  }

  const buttons = (question.options ?? []).slice(0, 8).map((o, i) => [{ text: o.label.slice(0, 60), data: `ans:${i}` }]);
  buttons.push([{ text: "⏭ Skip this job", data: `cancel:${app.jobId}` }]);
  await sendMessage(
    student.chatId,
    `❓ <b>${escapeHtml(job.company)}</b> (${escapeHtml(job.title)}) needs one more thing:\n\n<b>${escapeHtml(question.question)}</b>\n\n` +
      `<i>${question.options?.length ? "Tap an option" : "Reply with your answer"}. I'll remember it for future applications.</i>`,
    buttons,
  );
}

/** The student replied to a question (typed text, or tapped option number `optionIndex`). */
export async function answerQuestion(student: Student, jobId: string, text: string | null, optionIndex?: number): Promise<void> {
  const app = await getApplication(student.userId, jobId);
  const job = await getJob(jobId);
  const question = app?.questions?.[0];
  if (!app || !job || !question) {
    await clearAwaiting(student.userId);
    return sendMessage(student.chatId, "That application isn't waiting for an answer anymore. See /saved.");
  }

  // Work out the value to put in the form.
  let value: string | undefined;
  let display: string | undefined;
  if (question.options?.length) {
    const option =
      optionIndex !== undefined ? question.options[optionIndex] : question.options.find((o) => o.label.toLowerCase() === text?.trim().toLowerCase());
    if (!option) return sendMessage(student.chatId, "Please tap one of the options above.");
    value = option.value;
    display = option.label;
  } else if (text?.trim()) {
    value = display = text.trim().slice(0, 1000);
  }
  if (!value || !display) return;

  await saveAnswer(student.userId, answerKey(question.label), display);
  app.questions!.shift();
  app.fills = [...(app.fills ?? []), { key: question.key, selector: question.selector, type: question.type, label: question.label, value }];
  await saveApplication(student.userId, app);

  if (app.questions!.length > 0) return askNextQuestion(student, app, job);

  await clearAwaiting(student.userId);
  await sendMessage(student.chatId, "👍 Thanks! That's everything. Submitting now…");
  try {
    await submitApplication(student, app, job);
  } catch (error) {
    console.error(`[apply] submit failed for user ${student.userId} job ${jobId}:`, error);
    await handOff(student, app, job, "Something went wrong on my side while submitting.", app.url);
  }
  await askPendingQuestions(student);
}

/** "Skip this job" on a question. */
export async function cancelApplication(student: Student, jobId: string): Promise<void> {
  const app = await getApplication(student.userId, jobId);
  if ((await getAwaitingJob(student)) === jobId) await clearAwaiting(student.userId);
  if (app) {
    app.status = "cancelled";
    app.questions = [];
    await saveApplication(student.userId, app);
    await showStatus(student, app);
  }
  await sendMessage(student.chatId, "OK, I won't apply to that one.");
  await askPendingQuestions(student);
}

function getAwaitingJob(student: Student): Promise<string | null> {
  return getAwaiting(student.userId);
}

/** After one application's questions are done, start asking the next waiting one. */
async function askPendingQuestions(student: Student): Promise<void> {
  const waiting = (await listApplications(student.userId)).find((a) => a.status === "needs_info" && a.questions?.length && a.job);
  if (waiting?.job) await askNextQuestion(student, waiting, waiting.job);
}

/** Fill and submit in a fresh browser, then tell the student honestly what happened. */
async function submitApplication(student: Student, app: Application, job: Job): Promise<void> {
  if (!app.url || !app.domain || !student.resume) return handOff(student, app, job, "Something was missing to submit this one.");
  app.status = "applying";
  await saveApplication(student.userId, app);
  await showStatus(student, app);

  const resume = { bytes: await downloadFile(student.resume.fileId), fileName: student.resume.fileName };
  const { result, screenshot } = await runAgent(
    { mode: "submit", url: app.url, domain: app.domain, clickApply: !!app.clickApply, fills: app.fills ?? [] },
    resume,
  );
  console.log(`[apply] user ${student.userId} job ${job.id}: ${result.status} ${result.reason ?? ""}`);

  if (result.status === "submitted") {
    app.status = "submitted";
    await saveApplication(student.userId, app);
    await showStatus(student, app);
    const written = app.written?.length ? `\n✍️ I wrote: ${escapeHtml(app.written.join(", "))}, using only facts from your profile.` : "";
    const caption = `✅ <b>Applied!</b> ${escapeHtml(job.title)} — ${escapeHtml(job.company)}\nOn ${escapeHtml(app.domain)}, the company's own site.${written}\n\nWatch your email for their reply. Good luck! 🍀`;
    if (screenshot) return sendPhoto(student.chatId, screenshot, caption);
    return sendMessage(student.chatId, caption);
  }

  const reasons: Record<string, string> = {
    captcha: "The form asked for a captcha, which needs a human.",
    otp: "The site wants a verification code (OTP). Only you should ever enter that, on their site.",
  };
  const reason =
    result.status === "unconfirmed"
      ? `${result.reason} It may or may not have gone through. Check your email, or the link below, before applying again.`
      : reasons[result.reason ?? ""] ?? result.reason ?? "The form didn't accept my answers.";
  await handOff(student, app, job, reason, app.url, screenshot);
}

/** Give the application to the student: the official link plus every answer we prepared. */
async function handOff(student: Student, app: Application, job: Job, reason: string, link?: string, screenshot?: Buffer | null): Promise<void> {
  app.status = "needs_you";
  app.reason = reason;
  app.questions = [];
  await saveApplication(student.userId, app);
  await showStatus(student, app);
  if ((await getAwaitingJob(student)) === app.jobId) await clearAwaiting(student.userId);

  const answers = (app.fills ?? [])
    .filter((f) => f.type !== "file" && f.value !== "true")
    .map((f) => `• <b>${escapeHtml(f.label.slice(0, 80))}</b>: ${escapeHtml(f.value.slice(0, 400))}`)
    .join("\n");
  // Even when we stopped before seeing the form, the student gets their everyday details to copy.
  const details = student.profile
    ? detailLines(autofillData(student.profile))
        .map(([label, value]) => `• <b>${escapeHtml(label)}</b>: <code>${escapeHtml(value.slice(0, 200))}</code>`)
        .join("\n")
    : "";
  const text =
    `🙋 <b>Please apply to this one yourself</b>\n<b>${escapeHtml(job.title)}</b> — ${escapeHtml(job.company)}\n\n` +
    `<b>Why:</b> ${escapeHtml(reason)}\n\n👉 <a href="${escapeHtml(link ?? job.applyLink)}">Open the application</a>` +
    (answers ? `\n\n<b>Answers for this form, ready to copy:</b>\n${answers}` : "") +
    (details ? `\n\n<b>Your details</b> <i>(tap one to copy)</i>:\n${details}` : "") +
    `\n\n✨ Tip: /autofill gives you a bookmark that fills these into the form for you.`;
  if (screenshot) await sendPhoto(student.chatId, screenshot, "What the page looked like").catch(() => {});
  await sendMessage(student.chatId, text.slice(0, 4000));
}

function explainBlocker(result: AgentResult, job: Job): string {
  switch (result.blocker) {
    case "captcha":
      return "The page has a captcha, which needs a human.";
    case "login":
      return `${job.company}'s site needs you to log in or create an account first.`;
    case "off_domain":
    case "off_domain_form":
      return `${job.company}'s application form is on another website${result.detail ? ` (${result.detail})` : ""}, not their own. I only apply on official company sites.`;
    case "unverified":
      return `I couldn't confirm ${job.company}'s official website, and the page I opened doesn't mention ${job.company}, so I won't apply for you.`;
    case "no_form":
      return "I couldn't find an application form on the page. It may need extra clicks, or the listing may be closed.";
    default:
      return result.reason ? `The page didn't load properly (${result.reason}).` : "The page didn't load properly.";
  }
}

export const STATUS_TEXT: Record<Application["status"], string> = {
  applying: "⚙️ applying now",
  needs_info: "❓ waiting for your answer",
  submitted: "✅ applied",
  needs_you: "🙋 apply yourself",
  cancelled: "⏭ skipped",
};

/** Show the application's status on the job message's button. */
async function showStatus(student: Student, app: Application): Promise<void> {
  if (!app.messageId) return;
  await editButtons(student.chatId, app.messageId, [[{ text: STATUS_TEXT[app.status], data: "noop" }]]).catch(() => {});
}

/**
 * The Telegram bot's conversation logic, independent of how updates arrive
 * (webhook on Vercel: api/telegram.ts, or long polling locally: scripts/bot-dev.ts).
 *
 * 0. Consent: nothing happens until the student agrees to the terms.
 * 1. /start → 📎 resume PDF → AI profile → [✅ Looks right] / [✏️ Fix something]
 * 2. Matches arrive (right after confirming, then daily) → [✅ Apply] / [⏭ Skip]
 * 3. ✅ Apply → the bot applies on the company's official site, asking the student only when needed
 */
import { config } from "../radar.config.js";
import { answerQuestion, cancelApplication, STATUS_TEXT, startApplication } from "./apply/apply.js";
import { listApplications } from "./jobs.js";
import { findMatchesForStudent } from "./pipeline.js";
import type { Profile } from "./profile.js";
import { checkResumeFile, editProfile, parseResume, pdfToText, UserFacingError } from "./resume.js";
import {
  deleteStudent,
  getAwaiting,
  getOrCreateStudent,
  getStudent,
  saveStudent,
  type Student,
  withinDailyLimit,
} from "./students.js";
import { type Buttons, downloadFile, editButtons, escapeHtml, sendMessage, telegram } from "./telegram.js";

// Minimal shapes of the Telegram objects we use: https://core.telegram.org/bots/api#update
interface TgDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}
interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number };
  text?: string;
  document?: TgDocument;
}
interface TgCallbackQuery {
  id: string;
  from: { id: number };
  message?: { message_id: number; chat: { id: number } };
  data?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

const CONFIRM_BUTTONS: Buttons = [
  [
    { text: "✅ Looks right", data: "profile:ok" },
    { text: "✏️ Fix something", data: "profile:edit" },
  ],
];

const hasConsent = (s: Student) => s.consent?.version === config.termsVersion;

/** Entry point: handle one update. Never throws; errors are logged and reported to the student. */
export async function handleUpdate(update: TgUpdate): Promise<void> {
  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
  try {
    if (update.callback_query) await onButton(update.callback_query);
    else if (update.message) await onMessage(update.message);
  } catch (error) {
    console.error(`[bot] update ${update.update_id} failed:`, error);
    if (chatId) {
      const text = error instanceof UserFacingError ? error.message : "Sorry, something went wrong on my side. Please try again in a minute.";
      await sendMessage(chatId, text).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

async function onMessage(msg: TgMessage): Promise<void> {
  // Only private chats: resumes and personal details don't belong in groups.
  if (msg.chat.type !== "private" || !msg.from) return;
  const student = await getOrCreateStudent(msg.from.id, msg.chat.id);
  const text = msg.text?.trim() ?? "";

  if (text === "/delete") return askDelete(student);
  // Nothing else works until the student has agreed to the current terms.
  if (!hasConsent(student)) return sendConsent(student);

  if (msg.document) return onResume(student, msg.document);
  if (text.startsWith("/start")) return sendWelcome(student);
  if (text === "/help") return sendHelp(student);
  if (text === "/profile") return showProfile(student);
  if (text === "/jobs") return onJobsCommand(student);
  if (text === "/saved") return showSaved(student);
  if (text === "/terms") return sendMessage(student.chatId, `📄 Terms: ${config.siteUrl}/terms\n🔒 Privacy: ${config.siteUrl}/privacy`);

  // Is an application waiting for this student's answer?
  const awaitingJob = text && !text.startsWith("/") ? await getAwaiting(student.userId) : null;
  if (awaitingJob) return answerQuestion(student, awaitingJob, text);

  if (student.status === "editing" && student.profile && text) return onProfileEdit(student, student.profile, text);
  if (!student.profile) return sendMessage(student.chatId, "📎 Please send your resume as a PDF to get started.");
  return sendHelp(student);
}

async function onResume(student: Student, doc: TgDocument): Promise<void> {
  const problem = checkResumeFile(doc);
  if (problem) return sendMessage(student.chatId, problem);
  if (!(await withinDailyLimit(student.userId, "resume", config.limits.resumeParses))) {
    return sendMessage(student.chatId, "You've uploaded a lot of resumes today. Please try again tomorrow.");
  }

  await sendMessage(student.chatId, "📄 Got it! Reading your resume. This takes a few seconds...");
  await telegram("sendChatAction", { chat_id: student.chatId, action: "typing" });

  const text = await pdfToText(await downloadFile(doc.file_id));
  const profile = await parseResume(text);
  console.log(`[bot] parsed resume for user ${student.userId}: ${profile.skills.length} skills, ${profile.targetRoles.length} roles`);

  student.profile = profile;
  student.resume = { fileId: doc.file_id, fileName: doc.file_name ?? "resume.pdf" };
  student.status = "confirming";
  await saveStudent(student);

  await sendMessage(student.chatId, `Here's what I understood:\n\n${formatProfile(profile)}\n\nIs this right?`, CONFIRM_BUTTONS);
}

async function onProfileEdit(student: Student, profile: Profile, instruction: string): Promise<void> {
  if (!(await withinDailyLimit(student.userId, "edit", config.limits.profileEdits))) {
    return sendMessage(student.chatId, "That's a lot of edits for one day. Please try again tomorrow.");
  }
  await telegram("sendChatAction", { chat_id: student.chatId, action: "typing" });
  student.profile = await editProfile(profile, instruction);
  student.status = "confirming";
  await saveStudent(student);
  await sendMessage(student.chatId, `Updated:\n\n${formatProfile(student.profile)}\n\nIs this right now?`, CONFIRM_BUTTONS);
}

/** /jobs: search right now instead of waiting for the morning run. */
async function onJobsCommand(student: Student): Promise<void> {
  if (!student.confirmed || !student.profile) {
    return sendMessage(student.chatId, "📎 Send your resume and confirm your profile first, then I can search for you.");
  }
  if (!(await withinDailyLimit(student.userId, "jobs", config.limits.manualSearches))) {
    return sendMessage(student.chatId, "You've searched a few times today already. New matches also arrive every morning at 9. 🌅");
  }
  await sendMessage(student.chatId, "🔎 Searching for roles that match you. This takes about a minute...");
  await findMatchesForStudent(student, { notifyIfNone: true });
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

async function onButton(query: TgCallbackQuery): Promise<void> {
  const student = await getStudent(query.from.id);
  const [action, arg] = (query.data ?? "").split(":");
  // Answer the tap first: this stops the loading spinner, and can show a short toast.
  const toast = action === "apply" ? "On it! I'll update you here." : action === "skip" ? "Skipped" : undefined;
  await telegram("answerCallbackQuery", { callback_query_id: query.id, text: toast });
  if (!student) return;

  if (action === "consent") return onConsent(student, arg === "yes");
  if (action === "delete") {
    if (arg !== "yes") return sendMessage(student.chatId, "OK, nothing was deleted.");
    await deleteStudent(student.userId);
    return sendMessage(student.chatId, "🗑 Done. Everything this bot stored about you has been deleted. Send /start if you ever want to come back.");
  }
  if (!hasConsent(student)) return sendConsent(student);

  const message = query.message;
  switch (action) {
    case "profile":
      return arg === "ok" ? onProfileConfirmed(student) : onProfileEditRequested(student);
    case "apply":
      if (!arg) return;
      return startApplication(student, arg, message?.message_id);
    case "skip":
      if (message) await editButtons(message.chat.id, message.message_id, [[{ text: "⏭ Skipped", data: "noop" }]]).catch(() => {});
      return;
    case "ans": {
      const jobId = await getAwaiting(student.userId);
      if (jobId) return answerQuestion(student, jobId, null, Number(arg));
      return;
    }
    case "cancel":
      if (arg) return cancelApplication(student, arg);
  }
}

async function onConsent(student: Student, agreed: boolean): Promise<void> {
  if (!agreed) {
    await deleteStudent(student.userId);
    return sendMessage(student.chatId, "No problem. I haven't stored anything about you. Send /start if you change your mind. 👋");
  }
  student.consent = { version: config.termsVersion, at: new Date().toISOString() };
  await saveStudent(student);
  console.log(`[bot] user ${student.userId} agreed to terms ${config.termsVersion}`);
  await sendWelcome(student);
}

async function onProfileConfirmed(student: Student): Promise<void> {
  const firstTime = !student.confirmed;
  student.status = "active";
  student.confirmed = true;
  await saveStudent(student);

  if (!firstTime) return sendMessage(student.chatId, "✅ Profile saved. Your next matches and applications will use it.");

  await sendMessage(
    student.chatId,
    "🎉 You're all set! I'm looking for your first matches now. After that, new ones arrive every morning at 9.",
  );
  await findMatchesForStudent(student, { notifyIfNone: true });
}

async function onProfileEditRequested(student: Student): Promise<void> {
  student.status = "editing";
  await saveStudent(student);
  await sendMessage(
    student.chatId,
    "What should I change? Write it in your own words, for example:\n" +
      "• <i>Add Pune and Hyderabad to locations</i>\n" +
      "• <i>I'm looking for backend intern roles, not frontend</i>\n" +
      "• <i>My phone number is +91 98xxxxxx10</i>",
  );
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

/** The consent step: short version here, full terms on the website. */
async function sendConsent(student: Student): Promise<void> {
  await sendMessage(
    student.chatId,
    "👋 Hi! Before we start, please read this and agree.\n\n" +
      "• <b>Hobby project.</b> Internship Radar is a free side project by one developer. It is not a company, recruiter or professional service.\n" +
      "• <b>No guarantees.</b> I use AI and can make mistakes. Listings may be wrong or already closed. No job, interview or reply is promised.\n" +
      "• <b>Applying for you.</b> When you tap ✅ Apply, you allow me to fill in and submit that application in your name, on the company's official website only, using your resume and answers, and to accept that company's privacy notice for it.\n" +
      "• <b>Your responsibility.</b> Your information must be true, and you're responsible for checking your profile and choosing what to apply to.\n" +
      "• <b>Your data.</b> Your resume is read by an AI service (Groq) and stored with Upstash and Vercel. Telegram keeps your file. /delete erases what this bot stores.\n" +
      "• <b>At your own risk.</b> The developer isn't responsible for outcomes of using this bot.\n" +
      "• You're 18+, or have a parent's or guardian's permission.\n\n" +
      `📄 <a href="${config.siteUrl}/terms">Full terms</a> · 🔒 <a href="${config.siteUrl}/privacy">Privacy policy</a>`,
    [
      [
        { text: "✅ I agree", data: "consent:yes" },
        { text: "✖ No thanks", data: "consent:no" },
      ],
    ],
  );
}

async function askDelete(student: Student): Promise<void> {
  await sendMessage(student.chatId, "This deletes your profile, resume link, applications and saved answers. Are you sure?", [
    [
      { text: "🗑 Yes, delete everything", data: "delete:yes" },
      { text: "Cancel", data: "delete:no" },
    ],
  ]);
}

async function sendWelcome(student: Student): Promise<void> {
  await sendMessage(
    student.chatId,
    "🎯 <b>Welcome to Internship Radar</b>, your personal job-application assistant.\n\n" +
      "<b>What I do</b>\n" +
      "1. 📎 You send your <b>resume as a PDF</b>, and I build your profile\n" +
      "2. 🔎 Every morning I search for roles that fit you and score how well they match\n" +
      "3. ✅ You tap <b>Apply</b>, and I apply on the <b>company's official careers website</b>\n" +
      "4. ❓ If a form needs something that isn't on your resume, I ask you once and remember it\n" +
      "5. 🙋 If a site needs a human (captcha, login, OTP) or the job isn't on the company's own site, I send you the link and your answers, ready to copy\n\n" +
      "<b>⚠️ Stay safe</b>\n" +
      "• Never send me passwords, OTPs, Aadhaar/PAN, or bank or card details. I will <b>never</b> ask for them\n" +
      "• Anyone asking for those while claiming to be me is a scam\n\n" +
      "<b>🧪 This is a beta</b>\n" +
      "I use AI, so I can sometimes be unexpected: I might misread your resume, score a job wrong, or fill a field badly. " +
      "Check your profile (/profile), and the screenshot I send after each application.\n\n" +
      "📎 <b>Send your resume to begin.</b>",
  );
}

async function sendHelp(student: Student): Promise<void> {
  await sendMessage(
    student.chatId,
    "<b>Commands</b>\n" +
      "/jobs: find matching jobs now\n" +
      "/saved: your applications and their status\n" +
      "/profile: see or fix your profile\n" +
      "/terms: terms and privacy policy\n" +
      "/delete: erase all your data\n\n" +
      "Send a new PDF anytime to replace your resume.",
  );
}

async function showProfile(student: Student): Promise<void> {
  if (!student.profile) return sendMessage(student.chatId, "No profile yet. 📎 Send your resume as a PDF first.");
  await sendMessage(student.chatId, formatProfile(student.profile), CONFIRM_BUTTONS);
}

async function showSaved(student: Student): Promise<void> {
  const apps = await listApplications(student.userId);
  if (apps.length === 0) return sendMessage(student.chatId, "No applications yet. Tap ✅ Apply under a match to start one.");

  const lines = apps.slice(0, 20).map((a, i) => {
    if (!a.job) return `${i + 1}. <i>(expired listing)</i>, ${STATUS_TEXT[a.status]}`;
    const why = a.status === "needs_you" && a.reason ? `\n    <i>${escapeHtml(a.reason.slice(0, 120))}</i>` : "";
    return `${i + 1}. <a href="${escapeHtml(a.url ?? a.job.applyLink)}">${escapeHtml(a.job.title)}</a> — ${escapeHtml(a.job.company)}\n    ${STATUS_TEXT[a.status]}${why}`;
  });
  await sendMessage(student.chatId, `📋 <b>Your applications</b>\n\n${lines.join("\n")}`);
}

/** A short, readable profile summary for Telegram. Missing fields say so, so the student can fill them in. */
export function formatProfile(p: Profile): string {
  const missing = "<i>not found</i>";
  const e = (v: string | null | undefined) => (v ? escapeHtml(v) : missing);
  const edu = p.education[0];
  const eduLine = edu
    ? escapeHtml([edu.degree, edu.field].filter(Boolean).join(", ") + ` @ ${edu.institution}` + (edu.graduationYear ? ` (${edu.graduationYear})` : ""))
    : missing;

  return [
    `👤 <b>${e(p.name)}</b>`,
    `${escapeHtml(p.headline)}`,
    ``,
    `📧 ${e(p.email)}  ·  📱 ${e(p.phone)}`,
    `📍 ${e(p.city)}`,
    `🎓 ${eduLine}`,
    `🛠 ${p.skills.length ? escapeHtml(p.skills.slice(0, 12).join(", ")) : missing}`,
    ``,
    `🔎 <b>Roles I'll search for:</b> ${p.targetRoles.length ? escapeHtml(p.targetRoles.join(", ")) : missing}`,
    `🌍 <b>Locations:</b> ${p.preferredLocations.length ? escapeHtml(p.preferredLocations.join(", ")) : missing}`,
  ].join("\n");
}

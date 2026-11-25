/**
 * Phase 1: turn a resume PDF into a structured Profile.
 *
 *   PDF bytes ──unpdf──▶ plain text ──AI (strict JSON schema)──▶ Profile
 *
 * Groq models can't read PDFs directly, so we extract the text ourselves first.
 */
import { generateText, Output } from "ai";
import { extractText, getDocumentProxy } from "unpdf";
import { model } from "./ai.js";
import { type Profile, ProfileSchema } from "./profile.js";

/** Telegram bots can download files up to 20 MB; resumes are far smaller. */
export const MAX_RESUME_BYTES = 5 * 1024 * 1024;
const MAX_PAGES = 5;

/** Check the uploaded file before doing any work. Returns an error message, or null if OK. */
export function checkResumeFile(file: { mime_type?: string; file_size?: number }): string | null {
  if (file.mime_type !== "application/pdf") return "Please send your resume as a PDF file.";
  if ((file.file_size ?? 0) > MAX_RESUME_BYTES) return "That file is over 5 MB. Please send a smaller PDF.";
  return null;
}

export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  if (pdf.numPages > MAX_PAGES) throw new UserFacingError(`Your resume has ${pdf.numPages} pages. Please send one with at most ${MAX_PAGES}.`);
  const { text } = await extractText(pdf, { mergePages: true });
  if (text.trim().length < 100) {
    // Scanned/image-only PDFs have no text layer.
    throw new UserFacingError("I couldn't read any text in that PDF. Is it a scanned image? Please export it as a text PDF from Word or Google Docs.");
  }
  return text;
}

const RULES = `Rules:
- Use ONLY information written in the resume. Never guess or invent anything.
- If a field is not in the resume, use null (or an empty list).
- Copy contact details, grades and dates exactly as written.`;

export async function parseResume(resumeText: string): Promise<Profile> {
  const { output } = await generateText({
    model,
    output: Output.object({ schema: ProfileSchema }),
    system: `You extract structured profiles from student resumes for a job-search assistant.\n${RULES}\n- targetRoles and preferredLocations are suggestions based on the resume; the student will confirm them.`,
    prompt: resumeText,
  });
  return output;
}

/** Apply a free-text correction from the student, e.g. "add Pune to locations". */
export async function editProfile(profile: Profile, instruction: string): Promise<Profile> {
  const { output } = await generateText({
    model,
    output: Output.object({ schema: ProfileSchema }),
    system: `You update a student's job-search profile. Apply the student's requested change and keep everything else exactly the same.\n${RULES}\n- The student's message counts as a source of truth, like the resume.`,
    prompt: `Current profile (JSON):\n${JSON.stringify(profile)}\n\nStudent's change:\n${instruction}`,
  });
  return output;
}

/** An error whose message is safe and helpful to show the student. */
export class UserFacingError extends Error {}

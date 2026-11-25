/**
 * Decide what to put in each form field, from the student's profile and earlier answers.
 *
 * Rules (from the project's design):
 *  - Use only facts from the profile or answers the student gave. Never guess.
 *  - A REQUIRED field we can't answer becomes a question for the student.
 *  - An OPTIONAL field we can't answer is left empty.
 *  - Fields asking for sensitive data (Aadhaar, PAN, bank, passwords…) are never
 *    filled or asked about in chat: the student does that application themselves.
 */
import { generateText, type LanguageModel, Output } from "ai";
import { z } from "zod";
import { model } from "../ai.js";
import type { Profile } from "../profile.js";
import type { Job } from "../types.js";
import type { Fill, FormField } from "./runner.js";

/** A question for the student, tied to one form field. */
export interface Question {
  key: string;
  selector: string;
  type: string;
  label: string;
  question: string;
  options?: { value: string; label: string }[];
}

export interface AnswerPlan {
  fills: Fill[];
  questions: Question[];
  /** Set when the form needs something we must never handle in chat. */
  sensitive?: string;
  /** Labels of fields the AI wrote itself (e.g. a cover note), so we can tell the student. */
  written: string[];
}

const SENSITIVE = /aadha?ar|\bpan\b|pan card|passport|bank|account (number|no)|ifsc|upi|credit card|debit card|card number|cvv|password|\botp\b|social security|\bssn\b/i;

const PlanSchema = z.object({
  answers: z.array(
    z.object({
      key: z.string(),
      value: z.string().nullable().describe("What to enter, or null if unknown"),
      source: z.enum(["profile", "saved_answer", "written", "resume_file", "consent"]).nullable(),
    }),
  ),
  questions: z.array(
    z.object({
      key: z.string(),
      question: z.string().describe("A short, friendly question for the student, e.g. 'What monthly stipend do you expect?'"),
    }),
  ),
});

/** Normalized form of a field label, used as the key for remembered answers. */
export function answerKey(label: string): string {
  return label.toLowerCase().replace(/\*/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

export async function planAnswers(
  profile: Profile,
  savedAnswers: Record<string, string>,
  job: Job,
  fields: FormField[],
  llm: LanguageModel = model,
): Promise<AnswerPlan> {
  // Sensitive required fields → stop here, before any AI call.
  const sensitive = fields.find((f) => f.required && SENSITIVE.test(f.label));
  if (sensitive) return { fills: [], questions: [], sensitive: sensitive.label, written: [] };

  const usable = fields.filter((f) => !SENSITIVE.test(f.label));
  const { output } = await generateText({
    model: llm,
    output: Output.object({ schema: PlanSchema }),
    system:
      "You fill job application forms for a student. For every field, give the value to enter.\n" +
      "Rules:\n" +
      "- Use ONLY facts from the student's profile or their saved answers. Never guess or invent.\n" +
      "- Contact details, grades and dates: copy exactly.\n" +
      "- select/radio: value must be exactly one of the option `value`s.\n" +
      "- checkbox: 'true' to tick. Tick boxes that acknowledge the company's privacy policy/terms (the student agreed to this when signing up). Tick other boxes only if the profile/saved answers clearly say yes.\n" +
      "- file: 'RESUME' if the field is for a resume/CV, otherwise null.\n" +
      "- Open questions like a cover letter or 'why do you want to join': write a short, honest answer (max 120 words) using only profile facts; source 'written'.\n" +
      "- If a REQUIRED field can't be answered truthfully (e.g. expected stipend, notice period, work authorization, date of birth, gender), set value null and add a question for the student.\n" +
      "- Optional fields you can't answer: value null, no question.",
    prompt: JSON.stringify({
      job: { title: job.title, company: job.company, summary: job.summary },
      profile,
      savedAnswers,
      fields: usable.map(({ key, type, label, required, options }) => ({ key, type, label, required, options })),
    }),
  });

  return buildPlan(usable, output.answers, output.questions);
}

/**
 * Check the AI's answers against the real form, so a bad AI answer can't reach the company:
 * unknown keys are dropped, select/radio values must be real options, and every
 * required field ends up either filled or asked.
 */
export function buildPlan(
  fields: FormField[],
  answers: { key: string; value: string | null; source: string | null }[],
  aiQuestions: { key: string; question: string }[],
): AnswerPlan {
  const byKey = new Map(answers.map((a) => [a.key, a]));
  const asked = new Map(aiQuestions.map((q) => [q.key, q.question]));
  const fills: Fill[] = [];
  const questions: Question[] = [];
  const written: string[] = [];

  for (const field of fields) {
    const answer = byKey.get(field.key);
    let value = answer?.value?.trim() || null;

    if (value && field.options && !field.options.some((o) => o.value === value)) {
      // The AI may have answered with the label instead of the value.
      value = field.options.find((o) => o.label.toLowerCase() === value!.toLowerCase())?.value ?? null;
    }
    if (field.type === "file") value = value === "RESUME" ? "RESUME" : null;
    if (field.type === "checkbox" && value !== "true") value = null;

    if (value) {
      fills.push({ key: field.key, selector: field.selector, type: field.type, label: field.label, value });
      if (answer?.source === "written") written.push(field.label);
    } else if (field.required) {
      // File fields other than the resume can't be answered in chat.
      const question = field.type === "file" ? `This form needs a file for "${field.label}".` : asked.get(field.key) ?? `${field.label}?`;
      questions.push({ key: field.key, selector: field.selector, type: field.type, label: field.label, question, options: field.options });
    }
  }
  return { fills, questions, written };
}

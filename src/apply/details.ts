/**
 * A student's everyday application details (name, email, college, links...), used two ways
 * when the student applies themselves:
 *
 *  1. listed in the hand-off message, ready to copy
 *  2. packed into their personal autofill link (public/autofill.html), which turns them
 *     into a bookmarklet that fills those details into the form open in their own browser
 *
 * The autofill link carries the details after "#", which browsers never send to a server,
 * so they don't reach our site's logs. They only live in the student's Telegram chat and
 * their own bookmark.
 */
import { config } from "../../radar.config.js";
import type { Profile } from "../profile.js";

/** The keys the autofill page knows how to match to form fields. */
export interface AutofillData {
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  city?: string;
  linkedin?: string;
  github?: string;
  portfolio?: string;
  college?: string;
  degree?: string;
  field?: string;
  gradYear?: string;
  grade?: string;
  /** Answers the student gave the bot before: form label → answer. */
  answers?: Record<string, string>;
}

const LABELS: [keyof Omit<AutofillData, "answers" | "firstName" | "lastName">, string][] = [
  ["name", "Name"],
  ["email", "Email"],
  ["phone", "Phone"],
  ["city", "City"],
  ["college", "College"],
  ["degree", "Degree"],
  ["field", "Branch"],
  ["gradYear", "Graduation year"],
  ["grade", "CGPA / %"],
  ["linkedin", "LinkedIn"],
  ["github", "GitHub"],
  ["portfolio", "Portfolio"],
];

/** Profile + saved answers → the details we can fill. Empty values are left out. */
export function autofillData(profile: Profile, answers: Record<string, string> = {}): AutofillData {
  const edu = profile.education[0];
  const [firstName, ...rest] = (profile.name ?? "").trim().split(/\s+/);
  const data: AutofillData = {
    name: profile.name ?? undefined,
    firstName: firstName || undefined,
    lastName: rest.join(" ") || undefined,
    email: profile.email ?? undefined,
    phone: profile.phone ?? undefined,
    city: profile.city ?? undefined,
    linkedin: profile.links.linkedin ?? undefined,
    github: profile.links.github ?? undefined,
    portfolio: profile.links.portfolio ?? undefined,
    college: edu?.institution,
    degree: edu?.degree ?? undefined,
    field: edu?.field ?? undefined,
    gradYear: edu?.graduationYear ? String(edu.graduationYear) : undefined,
    grade: edu?.grade ?? undefined,
    answers: Object.keys(answers).length ? answers : undefined,
  };
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== "")) as AutofillData;
}

/** "Label: value" lines for the hand-off message (plain text; the caller escapes HTML). */
export function detailLines(data: AutofillData): [string, string][] {
  return LABELS.flatMap(([key, label]) => (data[key] ? [[label, data[key]!] as [string, string]] : []));
}

/** The student's personal autofill page: details travel in the "#" part only. */
export function autofillLink(data: AutofillData): string {
  const encoded = Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
  return `${config.siteUrl}/autofill#${encoded}`;
}

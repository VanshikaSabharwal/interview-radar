/**
 * A student's profile, extracted from their resume by the AI.
 *
 * Every field the resume doesn't contain is `null`. The AI is told never to
 * guess, and later phases ask the student for anything a form requires
 * that isn't here.
 */
import { z } from "zod";

export const ProfileSchema = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  city: z.string().nullable().describe("City the student lives in, as written on the resume"),
  headline: z.string().describe("One line, e.g. 'Final-year CS student, React + TypeScript'"),
  education: z.array(
    z.object({
      institution: z.string(),
      degree: z.string().nullable(),
      field: z.string().nullable(),
      graduationYear: z.number().nullable(),
      grade: z.string().nullable().describe("CGPA or percentage exactly as written"),
    }),
  ),
  skills: z.array(z.string()),
  experience: z.array(
    z.object({
      title: z.string(),
      company: z.string(),
      start: z.string().nullable(),
      end: z.string().nullable().describe("'Present' if ongoing"),
      summary: z.string(),
    }),
  ),
  projects: z.array(z.object({ name: z.string(), summary: z.string() })),
  links: z.object({
    linkedin: z.string().nullable(),
    github: z.string().nullable(),
    portfolio: z.string().nullable(),
  }),
  // These two are suggestions the student confirms. They drive the job search.
  targetRoles: z
    .array(z.string())
    .describe("2-4 short Google Jobs search queries that fit this student, e.g. 'frontend developer intern'"),
  preferredLocations: z
    .array(z.string())
    .describe("Where to search: the student's city as 'City, State, Country' if known, plus 'remote'"),
});

export type Profile = z.infer<typeof ProfileSchema>;

/**
 * Internship Radar settings. Searches now come from each student's profile
 * (their target roles × preferred locations), so this file only holds limits
 * and defaults. These limits protect your SearchApi and AI credits.
 */

/** One Google Jobs search. */
export interface Search {
  /** What you'd type into Google Jobs, e.g. "frontend intern". */
  query: string;
  /** A real place ("Bengaluru, Karnataka, India") or the special value "remote". */
  location: string;
  /** Optional 2-letter country code (Google's `gl`). Used for "remote" searches. */
  country?: string;
}

export const config = {
  /** Timezone for dates shown to students. */
  timezone: "Asia/Kolkata",
  /** Country used for "remote" searches (Google defaults to the US otherwise). */
  defaultCountry: "in",

  /** A job shown to (or rejected for) a student isn't considered again for this long. */
  seenJobTtlDays: 30,

  /** Searches per student per run = roles × locations, capped here. Each costs 1 SearchApi credit. */
  maxSearchesPerStudent: 4,
  /** Only jobs the AI scores at least this high (0-100) are sent. */
  minMatchScore: 60,
  /** At most this many matches per student per run. */
  maxMatchesPerRun: 8,
  /** At most this many new jobs go to the AI for scoring per student (keeps prompts small). */
  maxJobsToScore: 40,
  /**
   * How many students the daily run processes at the same time.
   * Keep 1 on Groq's free tier (~8,000 tokens/minute); raise it on a paid tier or AI Gateway.
   */
  concurrency: 1,

  /** Per-student daily limits. */
  limits: {
    resumeParses: 5,
    profileEdits: 15,
    manualSearches: 2, // the /jobs command
    applications: 10, // each one uses Vercel Sandbox time (Hobby: ~5 CPU-hours/month free)
  },

  /**
   * The public website (terms, privacy). Vercel sets VERCEL_PROJECT_PRODUCTION_URL
   * automatically on deployments; SITE_URL overrides it.
   */
  siteUrl:
    process.env.SITE_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "https://interviewradar-seven.vercel.app"),

  /** Change this when the terms change, and every student is asked to agree again. */
  termsVersion: "2026-11-25",
};

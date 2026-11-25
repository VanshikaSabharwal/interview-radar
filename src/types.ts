/** A job listing, reduced to the fields the bot needs. */
export interface Job {
  /** Stable ID: a hash of title + company + location (see dedupe.ts). */
  id: string;
  title: string;
  company: string;
  location: string;
  /** Relative time as Google shows it, e.g. "2 days ago". May be missing. */
  postedAt?: string;
  /** The main link to show the student. */
  applyLink: string;
  /** Every place this job can be applied to. Phase 3 picks the company's official site from these. */
  applyLinks: { link: string; source?: string }[];
  /** The start of the job description, used for matching. */
  summary?: string;
  /** The apply link on the company's own website, if there is one (set by the pipeline). */
  officialLink?: string;
  /** Set only for the /demo job: its "official" domain is this project's own site. */
  demoDomain?: string;
}

/** A job the AI scored against a student's profile. */
export interface Match extends Job {
  /** 0-100 */
  score: number;
  /** One short line explaining the score, shown to the student. */
  reason: string;
}

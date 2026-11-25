/**
 * Storage for job details and each student's applications.
 *
 *   job:<jobId>        the Job, so a button tap days later can find it again
 *   apps:<userId>      hash: jobId → Application (status + everything needed to finish it)
 */
import { config } from "../radar.config.js";
import type { Question } from "./apply/answers.js";
import type { Fill } from "./apply/runner.js";
import { redis } from "./redis.js";
import type { Job } from "./types.js";

export type ApplicationStatus =
  | "applying" // the bot is working on it
  | "needs_info" // waiting for the student to answer questions
  | "submitted" // done, confirmation seen
  | "needs_you" // handed off: the student applies themselves
  | "cancelled"; // the student skipped it

export interface Application {
  jobId: string;
  status: ApplicationStatus;
  updatedAt: string;
  /** The Telegram message with the job's buttons, so we can show the status there. */
  messageId?: number;
  /** Why it was handed off, in plain words. */
  reason?: string;
  // Filled in while applying:
  url?: string;
  domain?: string;
  clickApply?: boolean;
  fills?: Fill[];
  questions?: Question[];
  written?: string[];
}

export async function saveJobs(jobs: Job[]): Promise<void> {
  if (jobs.length === 0) return;
  const pipeline = redis().pipeline();
  for (const job of jobs) pipeline.set(`job:${job.id}`, job, { ex: config.seenJobTtlDays * 24 * 60 * 60 });
  await pipeline.exec();
}

export async function getJob(jobId: string): Promise<Job | null> {
  return redis().get<Job>(`job:${jobId}`);
}

export async function getApplication(userId: number, jobId: string): Promise<Application | null> {
  return (await redis().hget<Application>(`apps:${userId}`, jobId)) ?? null;
}

export async function saveApplication(userId: number, app: Application): Promise<void> {
  app.updatedAt = new Date().toISOString();
  await redis().hset(`apps:${userId}`, { [app.jobId]: app });
}

/** All of a student's applications, newest first, with job details attached. */
export async function listApplications(userId: number): Promise<(Application & { job: Job | null })[]> {
  const all = (await redis().hgetall<Record<string, Application>>(`apps:${userId}`)) ?? {};
  const apps = Object.values(all).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return Promise.all(apps.map(async (app) => ({ ...app, job: await getJob(app.jobId) })));
}

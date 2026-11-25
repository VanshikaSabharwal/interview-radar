/**
 * Per-student storage in Redis. Each Telegram user is one student.
 *
 *   student:<userId>    JSON: profile, resume file ID, consent
 *   answers:<userId>    hash: question → the student's answer (reused on later forms)
 *   awaiting:<userId>   the job whose question the student is answering right now
 *   students            a set of all student IDs (used by the daily run)
 *
 * The resume PDF itself is NOT stored here. Telegram keeps the file, and we
 * keep its `file_id`, which can download it again at any time.
 */
import type { Profile } from "./profile.js";
import { redis } from "./redis.js";

export type StudentStatus =
  | "awaiting_resume" // agreed to the terms, hasn't sent a PDF yet
  | "confirming" // profile extracted, waiting for "Looks right"
  | "editing" // student is typing a correction
  | "active"; // profile confirmed, the bot works for them

export interface Student {
  userId: number;
  chatId: number;
  status: StudentStatus;
  /** Which version of the terms the student agreed to, and when. */
  consent?: { version: string; at: string };
  /** True once the student has confirmed a profile at least once. Only these get daily matches. */
  confirmed?: boolean;
  profile?: Profile;
  resume?: { fileId: string; fileName: string };
  createdAt: string;
}

const key = (userId: number) => `student:${userId}`;

export async function getStudent(userId: number): Promise<Student | null> {
  return redis().get<Student>(key(userId));
}

export async function saveStudent(student: Student): Promise<void> {
  await redis().set(key(student.userId), student);
  await redis().sadd("students", student.userId);
}

/** Get the student, or create a new one if this is their first message. */
export async function getOrCreateStudent(userId: number, chatId: number): Promise<Student> {
  const existing = await getStudent(userId);
  if (existing) return existing;
  const student: Student = { userId, chatId, status: "awaiting_resume", createdAt: new Date().toISOString() };
  await saveStudent(student);
  return student;
}

/** /delete: remove everything we know about a student. */
export async function deleteStudent(userId: number): Promise<void> {
  await redis().del(key(userId), `apps:${userId}`, `answers:${userId}`, `awaiting:${userId}`);
  await redis().srem("students", userId);
  // "seen:<userId>:*" keys hold only job IDs (no personal data) and expire on their own.
}

/** Every student who has confirmed their profile. */
export async function listActiveStudents(): Promise<Student[]> {
  const ids = await redis().smembers("students");
  if (ids.length === 0) return [];
  const students = await redis().mget<(Student | null)[]>(...ids.map((id) => key(Number(id))));
  // `confirmed` (not status) so a student who is mid-edit still gets their daily matches.
  return students.filter((s): s is Student => !!s?.confirmed && !!s.profile);
}

// ---------------------------------------------------------------------------
// Answers the student gave to form questions
// ---------------------------------------------------------------------------

export async function getAnswers(userId: number): Promise<Record<string, string>> {
  return (await redis().hgetall<Record<string, string>>(`answers:${userId}`)) ?? {};
}

export async function saveAnswer(userId: number, question: string, answer: string): Promise<void> {
  await redis().hset(`answers:${userId}`, { [question]: answer });
}

// ---------------------------------------------------------------------------
// Which application is the student answering questions for?
// Only one at a time, so answers never go to the wrong form.
// ---------------------------------------------------------------------------

const awaitingKey = (userId: number) => `awaiting:${userId}`;

/** Claim the student's attention for this job. Returns false if another job is already asking. */
export async function claimAwaiting(userId: number, jobId: string): Promise<boolean> {
  const current = await redis().get<string>(awaitingKey(userId));
  if (current === jobId) return true;
  const result = await redis().set(awaitingKey(userId), jobId, { nx: true, ex: 3 * 24 * 60 * 60 });
  return result === "OK";
}

export async function getAwaiting(userId: number): Promise<string | null> {
  return redis().get<string>(awaitingKey(userId));
}

export async function clearAwaiting(userId: number): Promise<void> {
  await redis().del(awaitingKey(userId));
}

/**
 * Simple per-student daily limit, so one person can't burn through the
 * shared AI, SearchApi and Sandbox credits. Returns false once the limit is reached.
 */
export async function withinDailyLimit(userId: number, action: string, limit: number): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const k = `limit:${action}:${userId}:${day}`;
  const count = await redis().incr(k);
  if (count === 1) await redis().expire(k, 24 * 60 * 60);
  return count <= limit;
}

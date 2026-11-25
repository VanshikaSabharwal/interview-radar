/**
 * Read a required environment variable, or fail with a clear message.
 * Failing loudly here is much easier to debug than a mysterious 401 later.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name}. See .env.example.`);
  }
  return value;
}

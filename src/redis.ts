/** One shared Upstash Redis client for the whole app. */
import { Redis } from "@upstash/redis";
import { requireEnv } from "./env.js";

let client: Redis | undefined;

export function redis(): Redis {
  client ??= new Redis({
    url: requireEnv("UPSTASH_REDIS_REST_URL"),
    token: requireEnv("UPSTASH_REDIS_REST_TOKEN"),
  });
  return client;
}

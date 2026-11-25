/**
 * The one place that decides which AI model the app uses.
 *
 * Today: Groq (needs GROQ_API_KEY). To switch to Vercel AI Gateway later,
 * replace the export below with a plain model string, e.g.
 *
 *   export const model = process.env.AI_MODEL ?? "openai/gpt-oss-120b";
 *
 * The AI SDK routes plain strings through the gateway (it uses AI_GATEWAY_API_KEY,
 * or OIDC on Vercel). Nothing else in the code has to change.
 */
import { groq } from "@ai-sdk/groq";

// gpt-oss-120b on Groq supports strict JSON-schema output, which we rely on.
export const model = groq(process.env.AI_MODEL ?? "openai/gpt-oss-120b");

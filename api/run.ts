/**
 * GET /api/run: the daily run. Finds and sends new matches to every active student.
 *
 * Vercel calls it once a day (see "schedules" in vercel.json) and sends the
 * header `Authorization: Bearer <CRON_SECRET>`. Anyone else gets a 401, so
 * strangers can't trigger it and use up your credits.
 */
import { runDaily } from "../src/pipeline.js";
import { errorMessage } from "../src/searchapi.js";

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const summary = await runDaily();
    // If every student failed, report an error so it stands out in Vercel's logs.
    const allFailed = summary.students > 0 && summary.succeeded === 0;
    return Response.json(summary, { status: allFailed ? 502 : 200 });
  } catch (error) {
    // e.g. Redis unreachable: nothing was sent and nothing was marked as seen.
    console.error("[run] failed:", error);
    return Response.json({ error: errorMessage(error) }, { status: 500 });
  }
}

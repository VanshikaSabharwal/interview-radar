/**
 * POST /api/demo-apply: where the demo careers page (public/demo/careers.html) sends its form.
 *
 * It exists only so `/demo` in the bot can show a full, successful application
 * without touching a real company. It reads the upload and throws it away:
 * nothing is stored or logged.
 */
export async function POST(request: Request): Promise<Response> {
  await request.arrayBuffer(); // read and discard
  return new Response("ok");
}

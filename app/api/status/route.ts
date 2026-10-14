import { env } from "cloudflare:workers";
export const dynamic = "force-dynamic";
export async function GET() {
  const values = env as unknown as Record<string, string>;
  return Response.json({ ready: Boolean(values.TYPESAFE_API_KEY), model: values.TYPESAFE_MODEL || "jev-1.13.0" }, { headers: { "Cache-Control": "no-store" } });
}

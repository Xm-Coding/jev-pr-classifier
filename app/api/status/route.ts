import { env } from "cloudflare:workers";
import { checkServiceStatus } from "../../../lib/service-status.ts";
export const dynamic = "force-dynamic";
export async function GET() {
  const values = env as unknown as Record<string, string>;
  const status = await checkServiceStatus({apiKey: values.TYPESAFE_API_KEY, model: values.TYPESAFE_MODEL});
  console.info(JSON.stringify({event: "jev-availability", availability: status.availability, code: status.code, upstreamStatus: status.upstreamStatus}));
  return Response.json(status, { headers: { "Cache-Control": "no-store" } });
}

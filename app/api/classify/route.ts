import { env } from "cloudflare:workers";
import { handleClassify } from "../../../lib/classifier.ts";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const values = env as unknown as Record<string, string>;
  return handleClassify(request, { apiKey: values.TYPESAFE_API_KEY, model: values.TYPESAFE_MODEL,
    githubToken: values.GITHUB_TOKEN, giteeToken: values.GITEE_TOKEN, gitcodeToken: values.GITCODE_TOKEN, atomgitToken: values.ATOMGIT_TOKEN });
}

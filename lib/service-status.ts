import type { Fetcher, RuntimeConfig } from "./contracts.ts";
import { DEFAULT_MODEL } from "./model-policy.ts";
export interface ServiceStatus { ready: boolean; model: string; verifiedModel?: string; availability: "reachable" | "unavailable" | "not_configured"; code: string; message: string; upstreamStatus?: number }
let cached: { key: string; model: string; expires: number; result: Promise<ServiceStatus> } | undefined;
export function checkServiceStatus(config: RuntimeConfig, fetcher: Fetcher = fetch): Promise<ServiceStatus> {
  // Coalesce page-load probes within an isolate. Credentials never leave server memory.
  if (fetcher !== fetch || !config.apiKey) return probeModel(config, fetcher);
  const model = config.model || DEFAULT_MODEL;
  if (cached?.key === config.apiKey && cached.model === model && cached.expires > Date.now()) return cached.result;
  const result = probeModel(config, fetcher);
  cached = { key: config.apiKey, model, expires: Date.now() + 60_000, result };
  return result;
}
async function probeModel(config: RuntimeConfig, fetcher: Fetcher): Promise<ServiceStatus> {
  const base = { ready: Boolean(config.apiKey), model: config.model || DEFAULT_MODEL };
  if (!config.apiKey) return { ...base, availability: "not_configured", code: "KEY_NOT_CONFIGURED", message: "服务端尚未配置 Jev API key。" };
  let response: Response;
  try {
    response = await fetcher("https://api.typesafe.ai/v1/systemone", {
      method: "POST", headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: base.model, state: "The service is ready.", questions: { availability_check: { type: "noul", instructions: "Does the text say the service is ready?" } } }),
      redirect: "manual", signal: AbortSignal.timeout(25_000),
    });
  } catch { return { ...base, availability: "unavailable", code: "JEV_CONNECTION", message: "服务端暂时无法连接 TypeSafe，尚未验证模型调用。" }; }
  const upstreamStatus = response.status;
  if (response.ok) {
    let data: any;
    try { data = await response.json(); } catch { /* report invalid response below */ }
    const answer = data?.answers?.availability_check;
    if (typeof data?.model !== "string" || answer?.type !== "noul" || typeof answer.noul !== "number" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
      return { ...base, upstreamStatus, availability: "unavailable", code: "JEV_RESPONSE_INVALID", message: "模型检查未返回有效推理结果，暂不能确认可用。" };
    }
    if (/^jev-\d+\.\d+\.\d+$/.test(base.model) && data.model !== base.model) {
      return { ...base, upstreamStatus, availability: "unavailable", code: "JEV_MODEL_MISMATCH", message: "实际响应的模型版本与配置不一致，请检查服务端配置。" };
    }
    return { ...base, verifiedModel: data.model, upstreamStatus, availability: "reachable", code: "JEV_INFERENCE_VERIFIED", message: "已通过所选 Jev 模型的小型真实推理检查；具体 PR 是否分类成功以分析结果为准。" };
  }
  await response.body?.cancel();
  const message = upstreamStatus === 451 ? "TypeSafe 拒绝了此服务器地区的请求（HTTP 451），当前无法取得真实分类结果。" : [401,403].includes(upstreamStatus) ? "TypeSafe 拒绝了服务端凭据，请检查 Key 与账户权限。" : upstreamStatus === 402 ? "TypeSafe 账户额度不足，模型调用暂不可用。" : `TypeSafe 模型检查返回 HTTP ${upstreamStatus}，暂未确认所选模型可用。`;
  return { ...base, upstreamStatus, availability: "unavailable", code: upstreamStatus === 451 ? "JEV_REGION_UNAVAILABLE" : [401,403].includes(upstreamStatus) ? "JEV_AUTH" : upstreamStatus === 402 ? "JEV_BILLING" : "JEV_API_ERROR", message };
}

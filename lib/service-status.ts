import type { Fetcher, RuntimeConfig } from "./contracts.ts";
export interface ServiceStatus { ready: boolean; model: string; availability: "reachable" | "unavailable" | "not_configured"; code: string; message: string; upstreamStatus?: number }
export async function checkServiceStatus(config: RuntimeConfig, fetcher: Fetcher = fetch): Promise<ServiceStatus> {
  const base = { ready: Boolean(config.apiKey), model: config.model || "jev-1.13.0" };
  if (!config.apiKey) return { ...base, availability: "not_configured", code: "KEY_NOT_CONFIGURED", message: "服务端尚未配置 Jev API key。" };
  let response: Response;
  try { response = await fetcher("https://api.typesafe.ai/v1/models", { headers: { Authorization: `Bearer ${config.apiKey}` }, redirect: "manual", signal: AbortSignal.timeout(12_000) }); }
  catch { return { ...base, availability: "unavailable", code: "JEV_CONNECTION", message: "服务端暂时无法连接 TypeSafe，尚未验证模型调用。" }; }
  await response.body?.cancel();
  const upstreamStatus = response.status;
  if (response.ok && response.headers.get("Content-Type")?.includes("application/json")) return { ...base, upstreamStatus, availability: "reachable", code: "JEV_REACHABLE", message: "TypeSafe 模型接口可达；分类是否成功以实际分析结果为准。" };
  const message = upstreamStatus === 451 ? "TypeSafe 拒绝了此服务器地区的请求（HTTP 451），当前无法取得真实分类结果。" : [401,403].includes(upstreamStatus) ? "TypeSafe 拒绝了服务端凭据，请检查 Key 与账户权限。" : `TypeSafe 连接检查返回 HTTP ${upstreamStatus}，模型调用尚未验证。`;
  return { ...base, upstreamStatus, availability: "unavailable", code: upstreamStatus === 451 ? "JEV_REGION_UNAVAILABLE" : [401,403].includes(upstreamStatus) ? "JEV_AUTH" : "JEV_API_ERROR", message };
}

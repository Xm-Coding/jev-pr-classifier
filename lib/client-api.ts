// Browser-to-Site errors must stay distinct from Git provider and Jev errors.
export class SiteRequestError extends Error {
  code: string; requestId?: string;
  constructor(code: string, message: string, requestId?: string) { super(message); this.code = code; this.requestId = requestId; }
}
export async function requestSite<T>(path: string, init: RequestInit = {}, fetcher: typeof fetch = fetch): Promise<T> {
  const requestId = crypto.randomUUID();
  let response: Response;
  try {
    response = await fetcher(path, { ...init, credentials: "same-origin", redirect: "manual", cache: "no-store", headers: { ...Object.fromEntries(new Headers(init.headers)), "X-Request-ID": requestId } });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new SiteRequestError("SITE_CONNECTION", "浏览器未能取得工作台接口的响应，尚不能确认请求是否到达服务端。请刷新页面后重试；若仍失败，请检查网站登录状态及网络连接。", requestId);
  }
  if (response.type === "opaqueredirect" || response.status === 401 || response.status === 302) {
    throw new SiteRequestError("SITE_SIGN_IN", "工作台接口要求登录或发生了访问跳转。请重新登录工作台后重试。", requestId);
  }
  const id = response.headers.get("X-Request-ID") || requestId;
  if (!response.headers.get("Content-Type")?.includes("application/json")) {
    // Don't show raw HTML, authentication pages or upstream response contents.
    throw new SiteRequestError("SITE_NON_JSON", `工作台接口返回 HTTP ${response.status}，没有取得分类数据。可能是网站访问网关拦截或服务异常，请刷新并重新登录后重试。`, id);
  }
  let data: any;
  try { data = await response.json(); } catch {
    throw new SiteRequestError("SITE_RESPONSE_INVALID", "工作台接口返回的数据不完整，请重试。", id);
  }
  if (!response.ok) throw new SiteRequestError(data?.error?.code || "SITE_API_ERROR", data?.error?.message || "分析暂时失败，请重试。", data?.error?.requestId || id);
  return data as T;
}

import { AppError } from "./contracts.ts";
import type { AnalysisResult, Fetcher, PRRecord, RuntimeConfig } from "./contracts.ts";
import { CATEGORIES, CLASSIFICATION_QUESTION, RUBRIC_VERSION } from "./rubric.ts";
import { fetchPR, parsePRUrl } from "./pr-source.ts";
import { DEFAULT_MODEL, STANDARD_REQUEST_BYTES, LONG_REQUEST_BYTES, LONG_CONTEXT_HEADER, contextModeFor, supportsLongContext } from "./model-policy.ts";

const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;
export function sliceUtf8(text: string, budget: number): string {
  const bytes = encoder.encode(text); if (bytes.length <= budget) return text;
  for (let end = Math.max(0, budget); end >= Math.max(0, budget - 4); end--) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, end)); } catch { /* don't cut a UTF-8 character */ }
  }
  return "";
}
export function cleanText(text: string): string { return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ""); }

export function prepareState(pr: PRRecord, model: string) {
  const warnings = [...pr.warnings];
  const description = cleanText(pr.description).replace(/<!--[\s\S]*?-->/g, "");
  const state = {
    pr: { title: cleanText(pr.title), description,
      files: pr.files.map(f => ({ path: cleanText(f.path), status: f.status, additions: f.additions, deletions: f.deletions, diff: cleanText(f.patch) })),
    },
    input_quality: { total_changed_files: pr.changedFiles, provided_files: pr.files.length, diff_complete: pr.diffComplete, truncated: false },
  };
  const size = () => byteLength(JSON.stringify({ model, state, questions: { pr_category: CLASSIFICATION_QUESTION } }));
  const maxRequestBytes = supportsLongContext(model) ? LONG_REQUEST_BYTES : STANDARD_REQUEST_BYTES;
  // Preserve all available evidence if it fits. There is no longer a per-file 6KB cap.
  if (size() > maxRequestBytes) {
    state.pr.title = sliceUtf8(state.pr.title, 1000);
    state.pr.description = sliceUtf8(description, supportsLongContext(model) ? 20_000 : 5000);
    state.input_quality.truncated = true;
    state.input_quality.diff_complete = false;
    for (const f of state.pr.files) { f.path = sliceUtf8(f.path, 350); f.diff = ""; }
    while (size() > maxRequestBytes - 1000 && state.pr.files.length) state.pr.files.pop();
    state.input_quality.provided_files = state.pr.files.length;
    const available = Math.max(0, maxRequestBytes - size() - 500);
    const share = Math.floor(available / Math.max(1, state.pr.files.length));
    let truncatedFiles = 0;
    for (let i = 0; i < state.pr.files.length; i++) {
      const original = cleanText(pr.files[i].patch);
      state.pr.files[i].diff = sliceUtf8(original, share);
      if (state.pr.files[i].diff !== original) truncatedFiles++;
    }
    while (size() > maxRequestBytes) {
      const longest = state.pr.files.reduce((best, f) => f.diff.length > best.diff.length ? f : best, { diff: "" });
      if (!longest.diff) throw new AppError("INPUT_TOO_LARGE", "PR 的文件清单超过输入预算，请在平台中先整理该 PR。", 413);
      longest.diff = sliceUtf8(longest.diff, Math.floor(byteLength(longest.diff) * 0.8));
    }
    warnings.push(`PR 超出保守输入预算，部分内容已截取${truncatedFiles ? `（${truncatedFiles} 个文件的 diff）` : ""}；核心证据提取尚未实现，请人工复核。`);
    if (state.pr.files.length < pr.files.length) warnings.push("部分文件路径未放入模型输入。");
  }
  const requestBytes = size();
  const contextMode = contextModeFor(model, requestBytes);
  if (contextMode === "long") warnings.push("已启用长上下文模式。TypeSafe 提示此模式可能更慢且准确率下降；门限尚未针对长 PR 校准，建议人工复核。");
  return { state, warnings, inputComplete: state.input_quality.diff_complete, contextMode, requestBytes };
}

export function validateJevResponse(data: any) {
  const answer = data?.answers?.pr_category;
  const validIds = CATEGORIES.map(c => c.id);
  if (!answer || answer.type !== "choice" || !validIds.includes(answer.choice) || typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
    throw new AppError("JEV_RESPONSE_INVALID", "Jev 返回的分类结构与预期不一致，请重试。", 502);
  }
  const probabilities: Record<string, number> = {};
  for (const id of validIds) {
    const p = answer.probabilities?.[id];
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) throw new AppError("JEV_RESPONSE_INVALID", "Jev 返回的类别概率不完整，请重试。", 502);
    probabilities[id] = p;
  }
  const sum = Object.values(probabilities).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 0.02) throw new AppError("JEV_RESPONSE_INVALID", "Jev 返回的概率分布无效，请重试。", 502);
  // Preserve all API numbers and the API's chosen label; don't invent confidence or rescale probabilities.
  return { choice: answer.choice as string, confidence: answer.confidence as number, probabilities, model: String(data.model ?? "unknown"), usage: data.usage ?? {} };
}

export async function callJev(state: unknown, config: RuntimeConfig, fetcher: Fetcher = fetch) {
  if (!config.apiKey) throw new AppError("KEY_NOT_CONFIGURED", "服务端尚未配置 Jev API key。", 503);
  const model = config.model || DEFAULT_MODEL;
  const body = JSON.stringify({ model, state, questions: { pr_category: CLASSIFICATION_QUESTION } });
  const contextMode = contextModeFor(model, byteLength(body));
  if (byteLength(body) > (contextMode === "long" ? LONG_REQUEST_BYTES : STANDARD_REQUEST_BYTES)) throw new AppError("INPUT_TOO_LARGE", "分类请求超出当前输入预算，请先整理 PR 证据。", 413);
  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` };
  if (contextMode === "long") headers[LONG_CONTEXT_HEADER] = "true";
  const signal = AbortSignal.timeout(contextMode === "long" ? 90_000 : 45_000);
  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetcher("https://api.typesafe.ai/v1/systemone", {
        method: "POST", headers, body,
        // Workers supports manual/follow in our runtime; never forward the key on redirects.
        redirect: "manual", signal,
      });
    } catch { throw new AppError("JEV_CONNECTION", "Jev 请求超时或连接失败，请稍后重试。", 502); }
    if (![429, 529].includes(response.status) || attempt === 2) break;
    await response.body?.cancel();
    await new Promise(resolve => setTimeout(resolve, 600 * 2 ** attempt));
  }
  if (!response) throw new AppError("JEV_CONNECTION", "Jev 请求未完成。", 502);
  if (!response.ok) {
    // Upstream bodies may contain request data. Never return them or secret headers to the browser.
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) throw new AppError("JEV_AUTH", "Jev API key 无效或账户无权调用，请检查服务端配置。", 502);
    if (response.status === 402) throw new AppError("JEV_BILLING", "Jev 账户额度不足或尚未开通计费，请检查控制台。", 502);
    if (response.status === 451) throw new AppError("JEV_REGION_UNAVAILABLE", "TypeSafe 当前不向此服务器所在地区提供服务（HTTP 451），本次未取得分类结果。请核对 TypeSafe 的服务地区与账户可用性。", 502);
    if ([429, 529].includes(response.status)) throw new AppError("JEV_BUSY", "Jev 当前限流或繁忙，请稍后重试。", 503);
    throw new AppError("JEV_API_ERROR", `Jev 返回 ${response.status}，分类暂未完成。`, 502);
  }
  let data: unknown;
  try { data = await response.json(); } catch { throw new AppError("JEV_RESPONSE_INVALID", "Jev 返回了无法识别的数据。", 502); }
  return validateJevResponse(data);
}

export async function classifyPR(url: unknown, config: RuntimeConfig, fetcher: Fetcher = fetch): Promise<AnalysisResult> {
  const location = parsePRUrl(url);
  if (!config.apiKey) throw new AppError("KEY_NOT_CONFIGURED", "服务端尚未配置 Jev API key。", 503);
  const start = Date.now(); const pr = await fetchPR(location, config, fetcher); const fetched = Date.now();
  const prepared = prepareState(pr, config.model || DEFAULT_MODEL);
  const answer = await callJev(prepared.state, config, fetcher);
  const { files, description: _description, warnings: _warnings, diffComplete: _complete, ...metadata } = pr;
  return { ...answer, rubricVersion: RUBRIC_VERSION,
    pr: { ...metadata, files: files.map(({ patch: _patch, ...file }) => file) },
    warnings: prepared.warnings, inputComplete: prepared.inputComplete, contextMode: prepared.contextMode, requestBytes: prepared.requestBytes,
    elapsedMs: Date.now() - start, fetchMs: fetched - start, inferenceMs: Date.now() - fetched,
  };
}

export async function handleClassify(request: Request, config: RuntimeConfig, fetcher: Fetcher = fetch) {
  const suppliedId = request.headers.get("x-request-id");
  const requestId = suppliedId && /^[a-f0-9-]{36}$/i.test(suppliedId) ? suppliedId : crypto.randomUUID();
  const responseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Request-ID": requestId };
  try {
    if (request.method !== "POST") throw new AppError("METHOD_NOT_ALLOWED", "请使用 POST 请求。", 405);
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) throw new AppError("INVALID_ORIGIN", "请求来源不正确。", 403);
    if (Number(request.headers.get("content-length") ?? 0) > 4096) throw new AppError("REQUEST_TOO_LARGE", "请求过大。", 413);
    const text = await request.text(); if (byteLength(text) > 4096) throw new AppError("REQUEST_TOO_LARGE", "请求过大。", 413);
    let body: any; try { body = JSON.parse(text); } catch { throw new AppError("INVALID_REQUEST", "请求格式不正确。"); }
    const result = await classifyPR(body?.url, config, fetcher);
    return Response.json(result, { headers: responseHeaders });
  } catch (error) {
    const e = error instanceof AppError ? error : new AppError("INTERNAL_ERROR", "分析暂时失败，请稍后重试。", 500);
    const stage = e.code.startsWith("JEV_") || e.code === "KEY_NOT_CONFIGURED" ? "jev" : e.code.startsWith("SOURCE_") || e.code === "PR_NOT_FOUND" || e.code === "PR_TOO_LARGE" ? "pr_source" : "request";
    return Response.json({ error: { code: e.code, message: e.message, stage, requestId } }, { status: e.status, headers: responseHeaders });
  }
}
